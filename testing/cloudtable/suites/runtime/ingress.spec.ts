import { afterEach, describe, expect, it, vi } from "vitest";

import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import { handleQueueBatch } from "../../../../src/queues/consumer";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { serializeFieldTypeManifest } from "../../../../src/core/field-types/manifest";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createCloudTableD1Repository } from "../../../../src/core/persistence/cloudtable-d1-repository";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { serializeWorkflowOperatorManifest } from "../../../../src/core/workflows/manifest";
import { handleFetch, handleScheduled } from "../../../../src/runtime/worker";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
import {
  insertRecord,
  SqliteD1Database,
  seedAppAndTable,
  seedWorkspace
} from "../../harness/runtime/sqlite-d1";
import {
  buildWorkflowBindingContract,
  createAssigneeAliasWorkflowBindingField,
  createCheckboxWorkflowBindingField,
  createRelationWorkflowBindingField,
  createRowOwnerWorkflowBindingField,
  createSingleSelectWorkflowBindingField,
  createStatusWorkflowBindingField,
  createTitleWorkflowBindingField
} from "../../harness/workflow-binding-contract";

type StoredValue = unknown;

class FakeDurableObjectStorage {
  private readonly store = new Map<string, StoredValue>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }
}

class FakeDurableObjectState {
  readonly storage = new FakeDurableObjectStorage();

  constructor(private readonly name: string) {}

  get id(): { toString(): string } {
    return {
      toString: () => this.name
    };
  }
}

class FakeQueue {
  readonly sent: CloudTableQueueMessage[] = [];
  private remainingFailures = 0;

  failNext(count = 1): void {
    this.remainingFailures = Math.max(this.remainingFailures, count);
  }

  async send(message: CloudTableQueueMessage, _options?: QueueSendOptions): Promise<void> {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Simulated queue publish failure.");
    }

    this.sent.push(message);
  }
}

class FakeNamespace {
  private readonly instances = new Map<string, DurableObject>();

  constructor(
    private readonly build: (name: string) => DurableObject
  ) {}

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

function supportedConditionOperatorManifests(operatorIds: readonly string[]) {
  const registry = createWorkflowOperatorRegistry();
  return operatorIds.map((operatorId) =>
    serializeWorkflowOperatorManifest(registry.require(operatorId))
  );
}

function createCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
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

function createRouteBody(overrides: Partial<CommandEnvelope> = {}): Partial<CommandEnvelope> {
  return {
    actor: {
      mode: "user",
      principalId: "principal_1"
    },
    commandId: "cmd_1",
    idempotencyKey: "idem_1",
    payload: {},
    workspaceId: "ws_1",
    ...overrides
  };
}

function createEnv(): {
  aggregateQueue: FakeQueue;
  db: SqliteD1Database;
  deadLetterQueue: FakeQueue;
  env: CloudTableEnv;
  eventFanoutQueue: FakeQueue;
  projectionQueue: FakeQueue;
  workflowDispatchQueue: FakeQueue;
  workflowStepQueue: FakeQueue;
} {
  const db = new SqliteD1Database();
  seedWorkspace(db, "ws_1");
  seedAppAndTable(db, {
    workspaceId: "ws_1",
    tableId: "tbl_1"
  });

  const eventFanoutQueue = new FakeQueue();
  const workflowQueue = new FakeQueue();
  const workflowStepQueue = new FakeQueue();
  const projectionQueue = new FakeQueue();
  const aggregateQueue = new FakeQueue();
  const deadLetterQueue = new FakeQueue();

  let env!: CloudTableEnv;
  const workspaceNamespace = new FakeNamespace(
    (name) =>
      new WorkspaceControlDurableObject(
        new FakeDurableObjectState(name) as unknown as DurableObjectState,
        env
      ) as unknown as DurableObject
  );
  const tableNamespace = new FakeNamespace(
    (name) =>
      new TableCoordinatorDurableObject(
        new FakeDurableObjectState(name) as unknown as DurableObjectState,
        env
      ) as unknown as DurableObject
  );

  env = {
    AGGREGATE_MAINTENANCE_QUEUE: aggregateQueue as unknown as Queue<CloudTableQueueMessage>,
    ARTIFACTS_BUCKET: {} as R2Bucket,
    AUTH_ALLOWED_REDIRECT_ORIGINS: "https://app.example.test",
    AUTH_SESSION_SECRET: "test-session-secret",
    AUTH_SESSION_TTL_SECONDS: "3600",
    DB: db as unknown as D1Database,
    DEAD_LETTER_REPROCESSOR_QUEUE: deadLetterQueue as unknown as Queue<CloudTableQueueMessage>,
    EVENT_FANOUT_QUEUE: eventFanoutQueue as unknown as Queue<CloudTableQueueMessage>,
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://example.test/v1/auth/google/callback",
    PROJECTION_MAINTENANCE_QUEUE: projectionQueue as unknown as Queue<CloudTableQueueMessage>,
    TABLE_COORDINATOR_DO: tableNamespace as unknown as DurableObjectNamespace,
    WORKFLOW_DISPATCH_QUEUE: workflowQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKFLOW_STEP_QUEUE: workflowStepQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKSPACE_CONTROL_DO: workspaceNamespace as unknown as DurableObjectNamespace
  };

  return {
    aggregateQueue,
    db,
    deadLetterQueue,
    env,
    eventFanoutQueue,
    projectionQueue,
    workflowDispatchQueue: workflowQueue,
    workflowStepQueue
  };
}

function createScheduledController(scheduledTime: number): ScheduledController {
  return {
    cron: "* * * * *",
    noRetry() {},
    scheduledTime
  } as ScheduledController;
}

async function provisionWorkspaceMembershipIdentity(
  env: CloudTableEnv,
  input: {
    externalIdentity?: {
      externalSubject: string;
      id: string;
      providerKey: string;
    };
    principalId: string;
    roleKey?: string;
    userId: string;
  }
): Promise<Response> {
  return handleFetch(
    new Request("https://example.test/v1/workspaces/ws_1/memberships", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        membership: {
          organizationMembershipId: `orgmem:${input.userId}`,
          principalId: input.principalId,
          roleKey: input.roleKey ?? "workspace.member",
          workspaceMembershipId: `wsmem:${input.userId}`
        },
        ...(input.externalIdentity
          ? {
              externalIdentity: {
                email: `${input.userId}@example.com`,
                externalSubject: input.externalIdentity.externalSubject,
                id: input.externalIdentity.id,
                providerKey: input.externalIdentity.providerKey
              }
            }
          : {}),
        organization: {
          id: "org_1",
          name: "Org 1",
          slug: "org-1"
        },
        timestamp: "2026-06-10T00:00:00.000Z",
        user: {
          displayName: input.userId,
          email: `${input.userId}@example.com`,
          id: input.userId
        },
        workspace: {
          name: "Workspace 1",
          slug: "workspace-1"
        }
      })
    }),
    env,
    {} as ExecutionContext
  );
}

function readCookieHeaderFromSetCookie(setCookie: string): string {
  return setCookie.split(";", 1)[0]!;
}

async function createAuthenticatedCookie(
  env: CloudTableEnv,
  userId: string,
  options: { activeWorkspaceId?: string | null } = {}
): Promise<string> {
  const repository = createCloudTableD1Repository(env.DB);
  const issuedAt = "2026-06-10T01:00:00.000Z";
  const session = await repository.createAuthSession({
    activeWorkspaceId: options.activeWorkspaceId ?? null,
    expiresAt: "2099-06-10T02:00:00.000Z",
    lastAuthenticatedAt: issuedAt,
    sessionId: `session_${userId}`,
    userId
  });
  const payload = toBase64Url(JSON.stringify({ sessionId: session.sessionId }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_SESSION_SECRET ?? ""),
    {
      hash: "SHA-256",
      name: "HMAC"
    },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));

  return `cloudtable_session=${encodeURIComponent(`${payload}.${toBase64Url(signature)}`)}`;
}

function toBase64Url(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

afterEach(() => {
  vi.restoreAllMocks();
});

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

function createBatch(
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

function insertField(
  db: SqliteD1Database,
  input: {
    config?: Record<string, unknown>;
    fieldId: string;
    fieldOrder?: number | null;
    fieldKey: string;
    fieldType: string;
    label: string;
    tableId: string;
    workspaceId?: string;
  }
): void {
  db.inner
    .prepare(
      `INSERT INTO fields (
        id,
        workspace_id,
        table_id,
        field_order,
        field_key,
        label,
        field_type,
        field_type_version,
        config_json,
        created_at,
        updated_at,
        archived_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.fieldId,
      input.workspaceId ?? "ws_1",
      input.tableId,
      input.fieldOrder ?? null,
      input.fieldKey,
      input.label,
      input.fieldType,
      1,
      JSON.stringify(input.config ?? {}),
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );
}

function insertRecordProjection(
  db: SqliteD1Database,
  input: {
    fields: Record<string, unknown>;
    recordId: string;
    recordKey: string;
    tableId: string;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";
  db.inner
    .prepare(
      `INSERT INTO records (
        id,
        workspace_id,
        table_id,
        record_key,
        record_revision,
        created_at,
        updated_at,
        archived_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.recordId,
      workspaceId,
      input.tableId,
      input.recordKey,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
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
      workspaceId,
      input.tableId,
      input.recordId,
      JSON.stringify({
        fields: input.fields
      }),
      "",
      1,
      `evt_${input.recordId}`,
      "2026-06-06T00:00:00.000Z"
    );
}

function insertCellCurrent(
  db: SqliteD1Database,
  input: {
    fieldId: string;
    fieldKey: string;
    fieldType: string;
    recordId: string;
    tableId: string;
    value: unknown;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";
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
      workspaceId,
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

function insertEventLedgerEntry(
  db: SqliteD1Database,
  input: {
    actor?: {
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
        actor:
          input.actor ?? {
            mode: "user",
            principalId: "principal_1"
          },
        aggregateType: input.aggregateType ?? null,
        commandType: input.commandType,
        scope: "table"
      }),
      input.createdAt
    );
}

function insertFieldIndexEntry(
  db: SqliteD1Database,
  input: {
    boolValue?: boolean | null;
    datetimeValue?: string | null;
    fieldId: string;
    numberValue?: number | null;
    referenceValue?: string | null;
    recordId: string;
    tableId: string;
    textValue?: string | null;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";
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
      workspaceId,
      input.tableId,
      input.fieldId,
      input.recordId,
      input.textValue ?? input.referenceValue ?? null,
      input.numberValue ?? null,
      input.datetimeValue ?? null,
      input.boolValue == null ? null : Number(input.boolValue),
      `evt_index_${input.recordId}_${input.fieldId}`
    );
}

function insertView(
  db: SqliteD1Database,
  input: {
    filterFieldIds?: string[];
    filters?: Array<{
      comparator?: string;
      fieldId: string;
      operatorId: string;
      value?: unknown;
    }>;
    groupByFieldId?: string | null;
    showEmptyGroups?: boolean;
    sortFieldIds?: string[];
    sorts?: Array<{
      fieldId: string;
      mode?: string;
    }>;
    tableId: string;
    viewId: string;
    viewKey: string;
    viewName: string;
    visibleFieldIds: string[];
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";
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
      input.viewId,
      workspaceId,
      input.tableId,
      input.viewKey,
      input.viewName,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
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
      `${input.viewId}:v1`,
      workspaceId,
      input.viewId,
      1,
      JSON.stringify({
        filterFieldIds:
          input.filters?.map((filter) => filter.fieldId) ?? input.filterFieldIds ?? [],
        filters:
          input.filters ??
          (input.filterFieldIds ?? []).map((fieldId) => ({
            fieldId,
            operatorId: "is_not_empty"
          })),
        groupByFieldId: input.groupByFieldId ?? null,
        showEmptyGroups: input.showEmptyGroups ?? false,
        sortFieldIds: input.sorts?.map((sort) => sort.fieldId) ?? input.sortFieldIds ?? [],
        sorts:
          input.sorts ??
          (input.sortFieldIds ?? []).map((fieldId) => ({
            fieldId,
            mode: "ascending"
          })),
        visibleFieldIds: input.visibleFieldIds
      }),
      "2026-06-06T00:00:00.000Z",
      "usr_owner",
      null
    );
}

function insertWorkflow(
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

function insertWorkflowRun(
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

function insertWorkflowRunStep(
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

function insertWorkflowDeadLetter(
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

function insertWorkflowBackfillJob(
  db: SqliteD1Database,
  input: {
    attemptCount?: number;
    chunkSize?: number;
    completedAt?: string | null;
    createdAt?: string;
    cursor?: Record<string, unknown> | null;
    dependencyAlias: string;
    dependencyKind: "aggregate" | "sync";
    jobId: string;
    lastError?: string | null;
    processedCount?: number;
    reason?: string;
    status: string;
    updatedAt?: string;
    workflowId: string;
    workflowVersionId?: string;
    workspaceId?: string;
  }
): void {
  const workspaceId = input.workspaceId ?? "ws_1";
  db.inner
    .prepare(
      `INSERT INTO workflow_backfill_jobs (
        id,
        workspace_id,
        workflow_id,
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
        created_at,
        updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.jobId,
      workspaceId,
      input.workflowId,
      input.workflowVersionId ?? `${input.workflowId}:v1`,
      input.dependencyKind,
      input.dependencyAlias,
      input.reason ?? "manual",
      input.status,
      input.chunkSize ?? 250,
      input.cursor === undefined || input.cursor === null ? null : JSON.stringify(input.cursor),
      input.processedCount ?? 0,
      input.attemptCount ?? 0,
      input.lastError ?? null,
      input.createdAt ?? "2026-06-06T00:00:00.000Z",
      input.updatedAt ?? "2026-06-06T00:00:00.000Z",
      input.completedAt ?? null
    );
}

function insertPermissionSnapshot(db: SqliteD1Database, snapshot: EffectivePermissionSnapshot): void {
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
      snapshot.snapshotId,
      snapshot.workspaceId,
      snapshot.principalId,
      snapshot.policyRevision,
      snapshot.scopeHash,
      JSON.stringify(snapshot),
      "2026-06-06T00:00:00.000Z"
    );
}

function setFieldPrincipalPermission(
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

function insertAccountsLookupMaintenanceSchema(db: SqliteD1Database): void {
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
      "tbl_accounts",
      "ws_1",
      "app_1",
      "accounts",
      "Accounts",
      0,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      null
    );
  insertField(db, {
    fieldId: "fld_account",
    fieldKey: "account",
    fieldType: "relation.record",
    label: "Account",
    tableId: "tbl_1",
    config: {
      allowMultiple: false,
      targetTableId: "tbl_accounts"
    }
  });
  insertField(db, {
    fieldId: "fld_ticket_account_name",
    fieldKey: "ticket_account_name",
    fieldType: "computed.readonly",
    label: "Ticket Account Name",
    tableId: "tbl_1",
    config: {
      lookup: {
        sourceFieldId: "fld_account",
        targetFieldId: "fld_account_name"
      }
    }
  });
  insertField(db, {
    fieldId: "fld_account_name",
    fieldKey: "account_name",
    fieldType: "text.single_line",
    label: "Account Name",
    tableId: "tbl_accounts"
  });
}

function createLookupMaintenanceWorkflowDefinition(
  input: {
    omitPrincipal?: boolean;
    status?: "paused" | "published";
    workflowId: string;
  }
): Record<string, unknown> {
  return {
    actions: [],
    conditions: [],
    metadata: {
      lookupDefinitions: [
        {
          alias: "ticket_account_name",
          dependencyFieldIds: ["fld_account"],
          lookupSource: {
            kind: "related_record",
            resolverAlias: "account_lookup"
          },
          sourceRelationPath: "relatedTables.account_lookup",
          targetFieldId: "fld_ticket_account_name",
          valueFieldId: "fld_account_name"
        }
      ],
      relatedTableResolvers: [
        {
          alias: "account_lookup",
          sourceFieldId: "fld_account",
          strategy: "single_relation",
          targetTableId: "tbl_accounts"
        }
      ],
      status: input.status ?? "published",
      tableId: "tbl_1"
    },
    ...(input.omitPrincipal
      ? {}
      : {
          principal: {
            policyRevision: 33,
            principalId: "wf_lookup_manual_service",
            schemaEpoch: 0,
            scopeHash: "scope:wf:lookup-manual"
          }
        }),
    trigger: {
      match: {
        tableId: "tbl_1"
      },
      operatorId: "field_changed"
    },
    workflowId: input.workflowId
  };
}

describe("cloudtable runtime ingress", () => {
  it("allocates workspace sequence leases monotonically", async () => {
    const { db, env } = createEnv();
    const workspaceId = env.WORKSPACE_CONTROL_DO.idFromName("ws_1");
    const workspace = env.WORKSPACE_CONTROL_DO.get(workspaceId);

    const first = await workspace.fetch(
      new Request("https://cloudtable.internal/leases", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ownerKey: "ws_1:tbl_1",
          size: 4,
          workspaceId: "ws_1"
        })
      })
    );
    const second = await workspace.fetch(
      new Request("https://cloudtable.internal/leases", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          ownerKey: "ws_1:tbl_2",
          size: 4,
          workspaceId: "ws_1"
        })
      })
    );

    const firstBody = (await first.json()) as { lease: { startSequence: number; endSequence: number } };
    const secondBody = (await second.json()) as { lease: { startSequence: number; endSequence: number } };
    expect(firstBody.lease).toMatchObject({
      endSequence: 4,
      startSequence: 1
    });
    expect(secondBody.lease).toMatchObject({
      endSequence: 8,
      startSequence: 5
    });

    const leaseCount = db.inner
      .prepare(`SELECT COUNT(*) AS count FROM workspace_sequence_leases WHERE workspace_id = ?`)
      .get("ws_1") as { count: number };
    expect(leaseCount.count).toBe(2);
  });

  it("routes table commands through the coordinator and publishes outbox queue work", async () => {
    const { env, eventFanoutQueue } = createEnv();
    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(createCommand())
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aggregate: null;
      coordinator: { lease: { startSequence: number; endSequence: number } };
      result: { accepted: boolean; events: Array<{ eventId: string }> };
    };

    expect(body.result.accepted).toBe(true);
    expect(body.coordinator.lease.startSequence).toBe(1);
    expect(body.coordinator.lease.endSequence).toBe(256);
    expect(eventFanoutQueue.sent).toHaveLength(1);
    expect(eventFanoutQueue.sent[0]).toMatchObject({
      eventId: body.result.events[0].eventId,
      kind: "event-fanout",
      workspaceId: "ws_1"
    });
    expect(body.aggregate).toBeNull();
  });

  it("preserves accepted writes when the outbox publish fails and drains them on schedule", async () => {
    const { db, env, eventFanoutQueue } = createEnv();
    eventFanoutQueue.failNext();

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(createCommand())
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
      createScheduledController(Date.parse(failedOutbox.available_at) + 1_000),
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

  it("executes the base/table/field/record/cell command API vertical slice through worker routes", async () => {
    const { env } = createEnv();

    const createBase = await handleFetch(
      new Request("https://example.test/v1/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_base_1",
            idempotencyKey: "idem_base_1",
            payload: {
              baseId: "base_2",
              name: "Customer Ops",
              slug: "customer-ops"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createBase.status).toBe(200);

    const createTable = await handleFetch(
      new Request("https://example.test/v1/bases/base_2/tables", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_table_1",
            idempotencyKey: "idem_table_1",
            payload: {
              name: "Customers",
              slug: "customers",
              tableId: "tbl_customers"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createTable.status).toBe(200);

    const createField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_1",
            idempotencyKey: "idem_field_1",
            payload: {
              fieldId: "fld_name",
              fieldKey: "name",
              fieldType: "text.single_line",
              label: "Name"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createField.status).toBe(200);

    const configureFieldPermission = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers/fields/fld_name/permissions/usr_support",
        {
          method: "PUT",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_field_permission_1",
              idempotencyKey: "idem_field_permission_1",
              payload: {
                policy: {
                  agent: false,
                  read: "redacted",
                  workflow: true,
                  write: false
                }
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(configureFieldPermission.status).toBe(200);
    const configureFieldPermissionBody = (await configureFieldPermission.json()) as {
      aggregate: { id: string; type: string };
      result: { accepted: boolean; events: Array<{ eventType: string }> };
    };
    expect(configureFieldPermissionBody.aggregate).toEqual({
      id: "fld_name",
      type: "field"
    });
    expect(configureFieldPermissionBody.result.events[0]?.eventType).toBe(
      "field.permission.configured"
    );

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_1",
            idempotencyKey: "idem_record_1",
            payload: {
              recordId: "rec_customer_1"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const setCell = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers/records/rec_customer_1/cells/fld_name",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_1",
              idempotencyKey: "idem_cell_1",
              payload: {
                value: "Acme"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(setCell.status).toBe(200);

    const setCellBody = (await setCell.json()) as {
      aggregate: { id: string; type: string };
      result: { accepted: boolean; events: Array<{ eventType: string }> };
    };
    expect(setCellBody.aggregate).toEqual({
      id: "rec_customer_1:fld_name",
      type: "cell"
    });
    expect(setCellBody.result.events[0]?.eventType).toBe("cell.set");

    const readRecord = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers/records/rec_customer_1?workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(readRecord.status).toBe(200);
    const readBody = (await readRecord.json()) as {
      projection: { fields: { name: string } };
      projectionVersion: number;
      record: { record_revision: number };
    };
    expect(readBody.projection.fields.name).toBe("Acme");
    expect(readBody.projectionVersion).toBe(2);
    expect(readBody.record.record_revision).toBe(1);
  });

  it("creates, publishes, pauses, and inspects workflows through the worker routes", async () => {
    const { db, env } = createEnv();
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_inspect",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 22,
      schemaEpoch: 1,
      scopeHash: "scope:agent:workflow-inspect",
      commandTypes: ["workflow.create", "workflow.publish", "workflow.pause"],
      fields: {}
    });

    const createWorkflow = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflows", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_create_1",
            idempotencyKey: "idem_workflow_create_1",
            payload: {
              definition: {
                actions: [
                  {
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
                    },
                    operatorId: "set_cell"
                  }
                ],
                conditions: [],
                principal: {
                  policyRevision: 7,
                  principalId: "wf_service",
                  schemaEpoch: 0,
                  scopeHash: "scope:wf:status-sync"
                },
                trigger: {
                  match: {
                    fieldId: "fld_source",
                    fromWorkflow: false,
                    tableId: "tbl_1"
                  },
                  operatorId: "field_changed"
                },
                workflowId: "wf_pipeline"
              },
              name: "Pipeline",
              workflowId: "wf_pipeline",
              workflowKey: "pipeline"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createWorkflow.status).toBe(200);
    const createWorkflowBody = (await createWorkflow.json()) as {
      aggregate: { id: string; type: string };
      result: { accepted: boolean; diagnostics: string[] };
    };
    expect(createWorkflowBody.result).toMatchObject({
      accepted: true,
      diagnostics: []
    });
    expect(createWorkflowBody).toMatchObject({
      aggregate: {
        id: "wf_pipeline",
        type: "workflow"
      }
    });

    const publishWorkflow = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_pipeline/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_publish_1",
            idempotencyKey: "idem_workflow_publish_1"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(publishWorkflow.status).toBe(200);
    const publishBody = (await publishWorkflow.json()) as {
      result: { accepted: boolean; diagnostics: string[] };
    };
    expect(publishBody.result).toMatchObject({
      accepted: true,
      diagnostics: []
    });

    const inspectPublished = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workspaceId: "ws_1"
          },
          principalId: "agt_assist",
          toolId: "inspectWorkspace",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const publishedBody = (await inspectPublished.json()) as {
      output: {
        workspace: {
          workflows: Array<{
            status: string;
            workflowId: string;
          }>;
        };
      };
    };
    expect(publishedBody.output.workspace.workflows).toMatchObject([
      {
        status: "published",
        workflowId: "wf_pipeline"
      }
    ]);

    const pauseWorkflow = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_pipeline/pause", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_pause_1",
            idempotencyKey: "idem_workflow_pause_1"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(pauseWorkflow.status).toBe(200);
    const pauseBody = (await pauseWorkflow.json()) as {
      result: { accepted: boolean; diagnostics: string[] };
    };
    expect(pauseBody.result).toMatchObject({
      accepted: true,
      diagnostics: []
    });

    const inspectPaused = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workspaceId: "ws_1"
          },
          principalId: "agt_assist",
          toolId: "inspectWorkspace",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const pausedBody = (await inspectPaused.json()) as {
      output: {
        workspace: {
          workflows: Array<{
            name: string;
            status: string;
            workflowId: string;
          }>;
        };
      };
    };
    expect(pausedBody.output.workspace.workflows).toMatchObject([
      {
        name: "Pipeline",
        status: "paused",
        workflowId: "wf_pipeline"
      }
    ]);
  });

  it("rejects incompatible row.owner workflow condition bindings through workflow create ingress", async () => {
    const { db, env } = createEnv();
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_owner_guard",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 22,
      schemaEpoch: 1,
      scopeHash: "scope:agent:workflow-owner-guard",
      commandTypes: ["workflow.create"],
      fields: {}
    });

    const createWorkflow = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflows", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_create_owner_guard",
            idempotencyKey: "idem_workflow_create_owner_guard",
            payload: {
              definition: {
                actions: [
                  {
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
                    },
                    operatorId: "set_cell"
                  }
                ],
                conditions: [
                  {
                    input: {
                      comparator: "gt",
                      left: {
                        path: "row.owner.value"
                      },
                      right: 1
                    },
                    operatorId: "number_compare"
                  }
                ],
                principal: {
                  policyRevision: 7,
                  principalId: "wf_service",
                  schemaEpoch: 0,
                  scopeHash: "scope:wf:status-sync"
                },
                trigger: {
                  match: {
                    fieldId: "fld_status",
                    fromWorkflow: false,
                    tableId: "tbl_1"
                  },
                  operatorId: "field_changed"
                },
                workflowId: "wf_owner_guard"
              },
              name: "Owner Guard",
              workflowId: "wf_owner_guard",
              workflowKey: "owner-guard"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(createWorkflow.status).toBe(200);
    expect(
      (await createWorkflow.json()) as {
        result: { accepted: boolean; diagnostics: string[]; status: string };
      }
    ).toMatchObject({
      result: {
        accepted: false,
        diagnostics: ["workflow_condition_binding_operator_unsupported:0:row.owner:number_compare"],
        status: "rejected"
      }
    });
  });

  it("updates workflows through the route ingress, forks drafts from published versions, and publishes the revised draft", async () => {
    const { db, env } = createEnv();
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        status: null
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        actions: [
          {
            input: {
              fieldId: "fld_status",
              fieldType: "text.single_line",
              recordId: "rec_1",
              tableId: "tbl_1",
              value: "published"
            },
            operatorId: "set_cell"
          }
        ],
        conditions: [],
        metadata: {
          status: "published",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 7,
          principalId: "wf_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:status-sync"
        },
        trigger: {
          operatorId: "manual"
        },
        workflowId: "wf_manual_edit"
      },
      name: "Manual Edit",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_manual_edit",
      workflowKey: "manual-edit"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_editor",
      workspaceId: "ws_1",
      principalId: "usr_editor",
      policyRevision: 23,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.update", "workflow.publish", "workflow.manual"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_service",
      workspaceId: "ws_1",
      principalId: "wf_service",
      policyRevision: 7,
      schemaEpoch: 0,
      scopeHash: "scope:wf:status-sync",
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

    const updateWorkflow = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_manual_edit", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_update_1",
            idempotencyKey: "idem_workflow_update_1",
            payload: {
              definition: {
                actions: [
                  {
                    input: {
                      fieldId: "fld_status",
                      fieldType: "text.single_line",
                      recordId: "rec_1",
                      tableId: "tbl_1",
                      value: "draft-edit"
                    },
                    operatorId: "set_cell"
                  }
                ],
                conditions: [],
                metadata: {
                  status: "draft",
                  tableId: "tbl_1"
                },
                principal: {
                  policyRevision: 7,
                  principalId: "wf_service",
                  schemaEpoch: 0,
                  scopeHash: "scope:wf:status-sync"
                },
                trigger: {
                  operatorId: "manual"
                },
                workflowId: "wf_manual_edit"
              },
              name: "Manual Edit Revised"
            },
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(updateWorkflow.status).toBe(200);
    expect((await updateWorkflow.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: []
      }
    });

    const definitionAfterUpdate = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_manual_edit/definition?workspaceId=ws_1&principalId=usr_editor"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionAfterUpdate.status).toBe(200);
    expect((await definitionAfterUpdate.json()) as {
      currentVersion: number;
      definition: {
        actions: Array<{
          input: {
            value: string;
          };
        }>;
      };
      status: string;
    }).toMatchObject({
      currentVersion: 2,
      definition: {
        actions: [
          {
            input: {
              value: "draft-edit"
            }
          }
        ]
      },
      status: "draft"
    });

    const publishUpdatedDraft = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_manual_edit/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_publish_edited",
            idempotencyKey: "idem_workflow_publish_edited",
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(publishUpdatedDraft.status).toBe(200);

    const definitionAfterPublish = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_manual_edit/definition?workspaceId=ws_1&principalId=usr_editor"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionAfterPublish.status).toBe(200);
    expect((await definitionAfterPublish.json()) as {
      currentVersion: number;
      definition: {
        actions: Array<{
          input: {
            value: string;
          };
        }>;
      };
      publishedAt: string;
      status: string;
    }).toMatchObject({
      currentVersion: 2,
      definition: {
        actions: [
          {
            input: {
              value: "draft-edit"
            }
          }
        ]
      },
      status: "published"
    });
  });

  it("rejects workflow updates whose revised definitions fail workflow validation", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [
          {
            input: {
              fieldId: "fld_status",
              fieldType: "text.single_line",
              recordId: "rec_1",
              tableId: "tbl_1",
              value: "published"
            },
            operatorId: "set_cell"
          }
        ],
        conditions: [],
        metadata: {
          status: "draft",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 7,
          principalId: "wf_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:status-sync"
        },
        trigger: {
          operatorId: "manual"
        },
        workflowId: "wf_invalid_edit"
      },
      name: "Invalid Edit",
      workflowId: "wf_invalid_edit",
      workflowKey: "invalid-edit"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_invalid_editor",
      workspaceId: "ws_1",
      principalId: "usr_editor",
      policyRevision: 24,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.update"],
      fields: {}
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_invalid_edit", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_update_invalid",
            idempotencyKey: "idem_workflow_update_invalid",
            payload: {
              definition: {
                actions: [
                  {
                    input: {},
                    operatorId: "set_cell"
                  }
                ],
                conditions: [],
                metadata: {
                  status: "draft",
                  tableId: "tbl_1"
                },
                trigger: {
                  operatorId: "missing_trigger"
                },
                workflowId: "wf_invalid_edit"
              },
              name: "Invalid Edit"
            },
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { result: { accepted: boolean; diagnostics: string[]; status: string } }).toMatchObject({
      result: {
        accepted: false,
        diagnostics: ["workflow_trigger_unknown:missing_trigger"],
        status: "rejected"
      }
    });
  });

  it("executes manual workflow ingress with idempotent replay and queue fanout", async () => {
    const { db, env, eventFanoutQueue } = createEnv();
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        status: null
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
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
          scopeHash: "scope:wf:status-sync"
        },
        trigger: {
          operatorId: "manual"
        },
        workflowId: "wf_manual"
      },
      name: "Manual",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_manual",
      workflowKey: "manual"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_manual_user",
      workspaceId: "ws_1",
      principalId: "principal_1",
      policyRevision: 11,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.manual"],
      fields: {}
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_manual_workflow",
      workspaceId: "ws_1",
      principalId: "wf_service",
      policyRevision: 7,
      schemaEpoch: 0,
      scopeHash: "scope:wf:status-sync",
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

    const execute = async () =>
      handleFetch(
        new Request("https://example.test/v1/workflows/wf_manual/execute", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_workflow_manual_1",
              idempotencyKey: "idem_workflow_manual_1",
              payload: {
                input: {
                  trigger: "button"
                }
              },
              permissionScopeHash: "scope:workspace",
              permissionsVersion: 11
            })
          )
        }),
        env,
        {} as ExecutionContext
      );

    const first = await execute();
    expect(first.status).toBe(200);
    expect((await first.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: []
      }
    });

    const second = await execute();
    expect(second.status).toBe(200);
    expect((await second.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: ["idempotent_replay"]
      }
    });

    expect(eventFanoutQueue.sent).toHaveLength(1);
    expect(eventFanoutQueue.sent[0]).toMatchObject({
      eventId: expect.any(String),
      kind: "event-fanout",
      workspaceId: "ws_1"
    });
  });

  it("rejects manual workflow ingress for paused workflows", async () => {
    const { db, env, eventFanoutQueue } = createEnv();
    insertWorkflow(db, {
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
        metadata: {
          status: "paused"
        },
        principal: {
          policyRevision: 7,
          principalId: "wf_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:status-sync"
        },
        trigger: {
          operatorId: "manual"
        },
        workflowId: "wf_manual_paused"
      },
      name: "Manual Paused",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_manual_paused",
      workflowKey: "manual-paused"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_manual_paused_user",
      workspaceId: "ws_1",
      principalId: "principal_1",
      policyRevision: 12,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.manual"],
      fields: {}
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_manual_paused/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_manual_paused_1",
            idempotencyKey: "idem_workflow_manual_paused_1",
            permissionScopeHash: "scope:workspace",
            permissionsVersion: 12
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: "workflow_paused"
    });
    expect(eventFanoutQueue.sent).toHaveLength(0);
  });

  it("returns workflow history for a workflow and run through operator-safe ingress", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_history"
      },
      name: "History",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_history",
      workflowKey: "history"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_history_operator",
      workspaceId: "ws_1",
      principalId: "ops_1",
      policyRevision: 21,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });
    insertWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:12:00.000Z",
      state: {
        triggerEventId: "evt_workflow_trigger_1"
      },
      status: "dead_lettered",
      workflowId: "wf_history",
      workflowRunId: "wfr_history_1"
    });
    insertWorkflowRunStep(db, {
      inputPayload: {
        fieldId: "fld_status",
        recordId: "rec_missing",
        tableId: "tbl_1",
        value: "processed"
      },
      lastErrorCode: "record_not_found:rec_missing",
      output: {
        diagnostics: ["record_not_found:rec_missing"],
        status: "rejected"
      },
      status: "dead_lettered",
      stepId: "wfr_history_1:step:0",
      workflowRunId: "wfr_history_1"
    });
    insertWorkflowDeadLetter(db, {
      workflowRunId: "wfr_history_1",
      workflowStepId: "wfr_history_1:step:0"
    });

    const historyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_history/history?workspaceId=ws_1&principalId=ops_1&permissionScopeHash=scope:table:tbl_1&policyRevision=21"
      ),
      env,
      {} as ExecutionContext
    );
    expect(historyResponse.status).toBe(200);
    const historyBody = (await historyResponse.json()) as {
      runs: Array<{
        id: string;
        status: string;
        steps: Array<{
          deadLetter: {
            id: string;
            replayRequest: {
              id: string;
              requestedAt: string;
              requestedBy: string;
            } | null;
          } | null;
          id: string;
          replayEligible: boolean;
          replayRequested: boolean;
          status: string;
        }>;
      }>;
      workflowId: string;
    };
    expect(historyBody).toMatchObject({
      workflowId: "wf_history"
    });
    expect(historyBody.runs).toHaveLength(1);
    expect(historyBody.runs[0]).toMatchObject({
      id: "wfr_history_1",
      status: "dead_lettered",
      steps: [
        {
          deadLetter: {
            id: "wdl:wfr_history_1:step:0",
            replayRequest: null
          },
          id: "wfr_history_1:step:0",
          replayEligible: true,
          replayRequested: false,
          status: "dead_lettered"
        }
      ]
    });

    const runResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflow-runs/wfr_history_1?workspaceId=ws_1&principalId=ops_1&permissionScopeHash=scope:table:tbl_1&policyRevision=21"
      ),
      env,
      {} as ExecutionContext
    );
    expect(runResponse.status).toBe(200);
    const runBody = (await runResponse.json()) as {
      id: string;
      status: string;
      steps: Array<{
        deadLetter: {
          failureCode: string;
          id: string;
        } | null;
      }>;
      workflowId: string;
    };
    expect(runBody).toMatchObject({
      id: "wfr_history_1",
      status: "dead_lettered",
      steps: [
        {
          deadLetter: {
            failureCode: "record_not_found:rec_missing",
            id: "wdl:wfr_history_1:step:0"
          }
        }
      ],
      workflowId: "wf_history"
    });
  });

  it("returns workflow observability through named agent tools on the preview ingress", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_history_agent"
      },
      name: "History Agent",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_history_agent",
      workflowKey: "history-agent"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_history_agent",
      workspaceId: "ws_1",
      principalId: "ops_agent",
      policyRevision: 31,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });
    insertWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:12:00.000Z",
      state: {
        triggerEventId: "evt_workflow_trigger_agent_1"
      },
      status: "dead_lettered",
      workflowId: "wf_history_agent",
      workflowRunId: "wfr_history_agent_1"
    });
    insertWorkflowRunStep(db, {
      inputPayload: {
        fieldId: "fld_status",
        recordId: "rec_missing",
        tableId: "tbl_1",
        value: "processed"
      },
      lastErrorCode: "record_not_found:rec_missing",
      output: {
        diagnostics: ["record_not_found:rec_missing"],
        status: "rejected"
      },
      status: "dead_lettered",
      stepId: "wfr_history_agent_1:step:0",
      workflowRunId: "wfr_history_agent_1"
    });
    insertWorkflowDeadLetter(db, {
      workflowRunId: "wfr_history_agent_1",
      workflowStepId: "wfr_history_agent_1:step:0"
    });

    const directHistoryResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_history_agent/history?workspaceId=ws_1&principalId=ops_agent&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    const directRunResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflow-runs/wfr_history_agent_1?workspaceId=ws_1&principalId=ops_agent&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    const toolHistoryResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_history_agent"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_agent",
          toolId: "readWorkflowHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const toolRunResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowRunId: "wfr_history_agent_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_agent",
          toolId: "readWorkflowRunDetail",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directHistoryResponse.status).toBe(200);
    expect(directRunResponse.status).toBe(200);
    expect(toolHistoryResponse.status).toBe(200);
    expect(toolRunResponse.status).toBe(200);

    const directHistoryBody = await directHistoryResponse.json();
    const directRunBody = await directRunResponse.json();
    const toolHistoryBody = (await toolHistoryResponse.json()) as {
      input: {
        workflowId: string;
      };
      output: {
        history: Record<string, unknown>;
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
      };
    };
    const toolRunBody = (await toolRunResponse.json()) as {
      input: {
        workflowRunId: string;
      };
      output: {
        kind: string;
        run: Record<string, unknown>;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
      };
    };

    expect(toolHistoryBody.tool).toMatchObject({
      id: "readWorkflowHistory",
      phase: "draft",
      scope: "workflow"
    });
    expect(toolHistoryBody.input).toEqual({
      workflowId: "wf_history_agent"
    });
    expect(toolHistoryBody.output.kind).toBe("workflow-history");
    expect(toolHistoryBody.output.history).toEqual(directHistoryBody);

    expect(toolRunBody.tool).toMatchObject({
      id: "readWorkflowRunDetail",
      phase: "draft",
      scope: "workflow"
    });
    expect(toolRunBody.input).toEqual({
      workflowRunId: "wfr_history_agent_1"
    });
    expect(toolRunBody.output.kind).toBe("workflow-run-detail");
    expect(toolRunBody.output.run).toEqual(directRunBody);
  });

  it("enqueues manual aggregate backfill requests through workflow operator ingress and rejects duplicate request ids", async () => {
    const { aggregateQueue, db, env } = createEnv();

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
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1",
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      }
    });
    insertField(db, {
      fieldId: "fld_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_max_ticket_amount",
      fieldKey: "max_ticket_amount",
      fieldType: "computed.readonly",
      label: "Max Ticket Amount",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_amount"],
        expression: "aggregate.account_max_ticket_amount",
        resultValueType: "number"
      }
    });
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "max_ticket_amount",
              dependencyFieldIds: ["fld_amount"],
              groupingSource: {
                kind: "related_record",
                resolverAlias: "account"
              },
              operand: {
                fieldId: "fld_amount",
                kind: "source_field",
                valueType: "number"
              },
              operationId: "max_number",
              sourceRelationPath: "relatedTables.account",
              targetFieldId: "fld_max_ticket_amount"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "account",
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "published",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 26,
          principalId: "wf_aggregate_manual_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:aggregate-manual"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_aggregate_manual"
      },
      name: "Aggregate Manual",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_aggregate_manual",
      workflowKey: "aggregate-manual"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_aggregate_ops",
      workspaceId: "ws_1",
      principalId: "ops_aggregate",
      policyRevision: 26,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const request = async () =>
      handleFetch(
        new Request("https://example.test/v1/workflows/wf_aggregate_manual/aggregate-maintenance", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            aggregateAliases: ["max_ticket_amount"],
            kind: "backfill",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 26,
            principalId: "ops_aggregate",
            requestId: "manual-backfill-1",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

    const first = await request();
    expect(first.status).toBe(202);
    expect((await first.json()) as {
      aggregateAliases: string[];
      kind: string;
      requestId: string;
      status: string;
      workflowId: string;
      workflowVersionId: string;
    }).toMatchObject({
      aggregateAliases: ["max_ticket_amount"],
      kind: "backfill",
      requestId: "manual-backfill-1",
      status: "enqueued",
      workflowId: "wf_aggregate_manual",
      workflowVersionId: "wf_aggregate_manual:v1"
    });

    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "max_ticket_amount",
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "max_number",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_max_ticket_amount",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "manual"
        },
        workflowId: "wf_aggregate_manual",
        workflowVersionId: "wf_aggregate_manual:v1"
      },
      workspaceId: "ws_1"
    });

    const dependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_aggregate_manual/dependencies?workspaceId=ws_1&principalId=ops_aggregate&permissionScopeHash=scope:table:tbl_1&policyRevision=26"
      ),
      env,
      {} as ExecutionContext
    );
    expect(dependencyResponse.status).toBe(200);
    const dependencyBody = (await dependencyResponse.json()) as {
      backfillJobs: Array<{
        dependencyAlias: string;
        dependencyKind: string;
        reason: string;
        status: string;
      }>;
      dependencies: Array<{
        alias: string;
        dependencyFieldIds: string[];
        kind: string;
        sourceTableId: string | null;
        status: string;
        targetTableId: string | null;
      }>;
      summary: {
        attentionRequiredBackfillJobs: unknown[];
        backfillJobsByStatus: Record<string, number>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
        totalBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: unknown[];
    };
    expect(dependencyBody.dependencies).toContainEqual(
      expect.objectContaining({
        alias: "max_ticket_amount",
        dependencyFieldIds: ["fld_account", "fld_amount"],
        kind: "aggregate",
        sourceTableId: "tbl_1",
        status: "published",
        targetTableId: "tbl_accounts"
      })
    );
    expect(dependencyBody.backfillJobs).toContainEqual(
      expect.objectContaining({
        dependencyAlias: "max_ticket_amount",
        dependencyKind: "aggregate",
        reason: "manual",
        status: "queued"
      })
    );
    expect(dependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [],
      backfillJobsByStatus: {
        queued: 1
      },
      failedBackfillJobCount: 0,
      maintenanceState: "active",
      pendingBackfillJobCount: 1,
      totalBackfillJobCount: 1
    });
    expect(dependencyBody.suggestedMaintenanceRequests).toEqual([]);

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             last_error = ?,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run(
        "failed",
        "aggregate coordinator failed",
        "2026-06-06T00:13:00.000Z",
        "ws_1",
        "wf_aggregate_manual"
      );

    const failedDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_aggregate_manual/dependencies?workspaceId=ws_1&principalId=ops_aggregate&permissionScopeHash=scope:table:tbl_1&policyRevision=26"
      ),
      env,
      {} as ExecutionContext
    );
    expect(failedDependencyResponse.status).toBe(200);
    const failedDependencyBody = (await failedDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: Array<{
          lastError: string | null;
          operatorAction: string;
          staleRunning: boolean;
          status: string;
        }>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: Array<{
        input: {
          aggregateAliases: string[];
          kind: string;
          reason: string;
          requestId: string;
          workflowId: string;
          workspaceId: string;
        };
        reason: string;
        successorToolId: string;
        toolId: string;
      }>;
    };
    expect(failedDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          lastError: "aggregate coordinator failed",
          operatorAction: "retry_backfill",
          staleRunning: false,
          status: "failed"
        })
      ],
      failedBackfillJobCount: 1,
      maintenanceState: "attention_required",
      pendingBackfillJobCount: 0
    });
    expect(failedDependencyBody.suggestedMaintenanceRequests).toEqual([
      {
        input: {
          aggregateAliases: ["max_ticket_amount"],
          kind: "backfill",
          reason: "manual",
          requestId: "workflow-aggregate-maintenance:wf_aggregate_manual:backfill:manual",
          workflowId: "wf_aggregate_manual",
          workspaceId: "ws_1"
        },
        reason: "attention_required_backfill",
        successorToolId: "requestWorkflowAggregateMaintenance",
        toolId: "prepareWorkflowAggregateMaintenance"
      }
    ]);

    const prepareSuggestedAggregateMaintenance = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: failedDependencyBody.suggestedMaintenanceRequests[0]!.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_aggregate",
          toolId: failedDependencyBody.suggestedMaintenanceRequests[0]!.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(prepareSuggestedAggregateMaintenance.status).toBe(200);
    const prepareSuggestedAggregateMaintenanceBody =
      (await prepareSuggestedAggregateMaintenance.json()) as {
        output: {
          kind: string;
          successorInvocation: {
            input: {
              aggregateAliases: string[];
              kind: string;
              reason: string;
              requestId: string;
              workflowId: string;
              workspaceId: string;
            };
            toolId: string;
          };
        };
        tool: {
          id: string;
          phase: string;
          successorToolId: string | null;
        };
      };
    expect(prepareSuggestedAggregateMaintenanceBody.tool).toMatchObject({
      id: "prepareWorkflowAggregateMaintenance",
      phase: "preview",
      successorToolId: "requestWorkflowAggregateMaintenance"
    });
    expect(prepareSuggestedAggregateMaintenanceBody.output).toMatchObject({
      kind: "workflow-maintenance-draft",
      successorInvocation: {
        input: failedDependencyBody.suggestedMaintenanceRequests[0]!.input,
        toolId: "requestWorkflowAggregateMaintenance"
      }
    });

    const executeSuggestedAggregateMaintenance = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: prepareSuggestedAggregateMaintenanceBody.output.successorInvocation.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_aggregate",
          toolId: prepareSuggestedAggregateMaintenanceBody.output.successorInvocation.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(executeSuggestedAggregateMaintenance.status).toBe(200);
    expect((await executeSuggestedAggregateMaintenance.json()) as {
      output: {
        aliases: string[];
        dependencyKind: string;
        kind: string;
        requestId: string;
        status: string;
        workflowId: string;
        workflowVersionId: string;
      };
      tool: {
        id: string;
        phase: string;
      };
    }).toMatchObject({
      output: {
        aliases: ["max_ticket_amount"],
        dependencyKind: "aggregate",
        kind: "workflow-maintenance-request",
        requestId: "workflow-aggregate-maintenance:wf_aggregate_manual:backfill:manual",
        status: "enqueued",
        workflowId: "wf_aggregate_manual",
        workflowVersionId: "wf_aggregate_manual:v1"
      },
      tool: {
        id: "requestWorkflowAggregateMaintenance",
        phase: "execute"
      }
    });
    expect(aggregateQueue.sent).toHaveLength(2);
    expect(aggregateQueue.sent[1]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "max_ticket_amount"
        },
        trigger: {
          kind: "backfill",
          reason: "manual"
        },
        workflowId: "wf_aggregate_manual",
        workflowVersionId: "wf_aggregate_manual:v1"
      },
      workspaceId: "ws_1"
    });

    const duplicate = await request();
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as { message: string }).toMatchObject({
      message:
        "Aggregate maintenance request manual-backfill-1 was already accepted for workflow wf_aggregate_manual."
    });

    const abandonResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_aggregate_manual/backfill-jobs/wbf:ws_1:wf_aggregate_manual:v1:aggregate:max_ticket_amount:manual/disposition",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            disposition: "abandoned",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 26,
            principalId: "ops_aggregate",
            reason: "workflow definition replaced before retry",
            workspaceId: "ws_1"
          })
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(abandonResponse.status).toBe(202);
    expect((await abandonResponse.json()) as {
      jobId: string;
      operatorReason: string;
      status: string;
    }).toMatchObject({
      jobId: "wbf:ws_1:wf_aggregate_manual:v1:aggregate:max_ticket_amount:manual",
      operatorReason: "workflow definition replaced before retry",
      status: "abandoned"
    });

    const abandonedDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_aggregate_manual/dependencies?workspaceId=ws_1&principalId=ops_aggregate&permissionScopeHash=scope:table:tbl_1&policyRevision=26"
      ),
      env,
      {} as ExecutionContext
    );
    expect(abandonedDependencyResponse.status).toBe(200);
    const abandonedDependencyBody = (await abandonedDependencyResponse.json()) as {
      summary: {
        abandonedBackfillJobCount: number;
        attentionRequiredBackfillJobs: unknown[];
        intentionallyClosedBackfillJobs: Array<{
          operatorAction: string;
          operatorActorPrincipalId: string;
          operatorReason: string;
          status: string;
        }>;
        maintenanceState: string;
        terminalBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: unknown[];
    };
    expect(abandonedDependencyBody.summary).toMatchObject({
      abandonedBackfillJobCount: 1,
      attentionRequiredBackfillJobs: [],
      intentionallyClosedBackfillJobs: [
        expect.objectContaining({
          operatorAction: "abandoned_backfill",
          operatorActorPrincipalId: "ops_aggregate",
          operatorReason: "workflow definition replaced before retry",
          status: "abandoned"
        })
      ],
      maintenanceState: "complete",
      terminalBackfillJobCount: 1
    });
    expect(abandonedDependencyBody.suggestedMaintenanceRequests).toEqual([]);
  });

  it("enqueues manual sync backfill requests through workflow operator ingress and rejects duplicate request ids", async () => {
    const { aggregateQueue, db, env } = createEnv();

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
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1",
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      }
    });
    insertField(db, {
      fieldId: "fld_source_status",
      fieldKey: "source_status",
      fieldType: "text.single_line",
      label: "Source Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_account_status",
      fieldKey: "account_status",
      fieldType: "text.single_line",
      label: "Account Status",
      tableId: "tbl_accounts"
    });
    insertWorkflow(db, {
      definition: {
        actions: [
          {
            input: {
              resolverAlias: "destination",
              sourceFieldId: "fld_source_status",
              targetFieldId: "fld_account_status"
            },
            operatorId: "sync_related_field"
          }
        ],
        conditions: [],
        metadata: {
          relatedTableResolvers: [
            {
              alias: "destination",
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "published",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 31,
          principalId: "wf_sync_manual_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:sync-manual"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_sync_manual"
      },
      name: "Sync Manual",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_sync_manual",
      workflowKey: "sync-manual"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_sync_ops",
      workspaceId: "ws_1",
      principalId: "ops_sync",
      policyRevision: 31,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const request = async () =>
      handleFetch(
        new Request("https://example.test/v1/workflows/wf_sync_manual/sync-maintenance", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            kind: "backfill",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 31,
            principalId: "ops_sync",
            requestId: "manual-sync-backfill-1",
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

    const first = await request();
    expect(first.status).toBe(202);
    expect((await first.json()) as {
      kind: string;
      requestId: string;
      status: string;
      syncAliases: string[];
      workflowId: string;
      workflowVersionId: string;
    }).toMatchObject({
      kind: "backfill",
      requestId: "manual-sync-backfill-1",
      status: "enqueued",
      syncAliases: ["destination:fld_source_status:fld_account_status"],
      workflowId: "wf_sync_manual",
      workflowVersionId: "wf_sync_manual:v1"
    });

    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        sync: {
          alias: "destination:fld_source_status:fld_account_status",
          dependencyFieldIds: ["fld_account", "fld_source_status"],
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceFieldId: "fld_source_status",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_account_status",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "manual"
        },
        workflowId: "wf_sync_manual",
        workflowVersionId: "wf_sync_manual:v1"
      },
      workspaceId: "ws_1"
    });

    const dependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/dependencies?workspaceId=ws_1&principalId=ops_sync&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    expect(dependencyResponse.status).toBe(200);
    const dependencyBody = (await dependencyResponse.json()) as {
      backfillJobs: Array<{
        dependencyAlias: string;
        dependencyKind: string;
        reason: string;
        status: string;
      }>;
      dependencies: Array<{
        alias: string;
        dependencyFieldIds: string[];
        kind: string;
        sourceTableId: string | null;
        status: string;
        targetTableId: string | null;
        updatedAt: string;
      }>;
      summary: {
        attentionRequiredBackfillJobs: unknown[];
        backfillJobsByStatus: Record<string, number>;
        completedBackfillJobCount: number;
        dependenciesByKind: Record<string, number>;
        dependenciesByStatus: Record<string, number>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
        resumableBackfillJobCount: number;
        runningBackfillJobCount: number;
        totalBackfillProcessedCount: number;
        totalBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: unknown[];
    };
    expect(dependencyBody.dependencies).toContainEqual(
      expect.objectContaining({
        alias: "destination:fld_source_status:fld_account_status",
        dependencyFieldIds: ["fld_account", "fld_source_status"],
        kind: "sync",
        sourceTableId: "tbl_1",
        status: "published",
        targetTableId: "tbl_accounts"
      })
    );
    expect(dependencyBody.backfillJobs).toContainEqual(
      expect.objectContaining({
        dependencyAlias: "destination:fld_source_status:fld_account_status",
        dependencyKind: "sync",
        reason: "manual",
        status: "queued"
      })
    );
    expect(dependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [],
      backfillJobsByStatus: {
        queued: 1
      },
      completedBackfillJobCount: 0,
      dependenciesByKind: expect.objectContaining({
        sync: 1
      }),
      dependenciesByStatus: expect.objectContaining({
        published: expect.any(Number)
      }),
      failedBackfillJobCount: 0,
      maintenanceState: "active",
      pendingBackfillJobCount: 1,
      resumableBackfillJobCount: 0,
      runningBackfillJobCount: 0,
      totalBackfillProcessedCount: 0,
      totalBackfillJobCount: 1
    });
    expect(dependencyBody.suggestedMaintenanceRequests).toEqual([]);

    const toolDependencyResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_sync_manual"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_sync",
          toolId: "readWorkflowDependencies",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolDependencyResponse.status).toBe(200);
    const toolDependencyBody = (await toolDependencyResponse.json()) as {
      input: {
        workflowId: string;
      };
      output: {
        dependencies: Record<string, unknown>;
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
      };
    };
    expect(toolDependencyBody.tool).toMatchObject({
      id: "readWorkflowDependencies",
      phase: "draft",
      scope: "workflow"
    });
    expect(toolDependencyBody.input).toEqual({
      workflowId: "wf_sync_manual"
    });
    expect(toolDependencyBody.output.kind).toBe("workflow-dependencies");
    const stableDependencySnapshot = (body: typeof dependencyBody) => ({
      ...body,
      dependencies: body.dependencies.map(({ updatedAt: _updatedAt, ...dependency }) => dependency)
    });
    expect(stableDependencySnapshot(toolDependencyBody.output.dependencies as typeof dependencyBody)).toEqual(
      stableDependencySnapshot(dependencyBody)
    );

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             cursor_json = ?,
             processed_count = ?,
             last_error = NULL,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run(
        "running",
        JSON.stringify({ lastRecordId: "rec_1" }),
        2,
        "2026-06-06T00:00:00.000Z",
        "ws_1",
        "wf_sync_manual"
      );

    const staleRunningDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/dependencies?workspaceId=ws_1&principalId=ops_sync&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    expect(staleRunningDependencyResponse.status).toBe(200);
    const staleRunningDependencyBody = (await staleRunningDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: Array<{
          lastError: string | null;
          operatorAction: string;
          staleRunning: boolean;
          status: string;
        }>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
        staleRunningBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: Array<{
        input: {
          kind: string;
          reason: string;
          requestId: string;
          syncAliases: string[];
          workflowId: string;
          workspaceId: string;
        };
        reason: string;
        successorToolId: string;
        toolId: string;
      }>;
    };
    expect(staleRunningDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          lastError: null,
          operatorAction: "retry_backfill",
          staleRunning: true,
          status: "running"
        })
      ],
      failedBackfillJobCount: 1,
      maintenanceState: "attention_required",
      pendingBackfillJobCount: 1,
      staleRunningBackfillJobCount: 1
    });
    expect(staleRunningDependencyBody.suggestedMaintenanceRequests).toEqual([
      {
        input: {
          kind: "backfill",
          reason: "manual",
          requestId: "workflow-sync-maintenance:wf_sync_manual:backfill:manual",
          syncAliases: ["destination:fld_source_status:fld_account_status"],
          workflowId: "wf_sync_manual",
          workspaceId: "ws_1"
        },
        reason: "attention_required_backfill",
        successorToolId: "requestWorkflowSyncMaintenance",
        toolId: "prepareWorkflowSyncMaintenance"
      }
    ]);

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             cursor_json = ?,
             processed_count = ?,
             last_error = ?,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run(
        "running",
        JSON.stringify({ lastRecordId: "rec_1" }),
        2,
        "transient coordinator failure",
        "2026-06-06T00:12:00.000Z",
        "ws_1",
        "wf_sync_manual"
      );

    const runningDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/dependencies?workspaceId=ws_1&principalId=ops_sync&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    expect(runningDependencyResponse.status).toBe(200);
    const runningDependencyBody = (await runningDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: Array<{
          lastError: string | null;
          operatorAction: string;
          staleRunning: boolean;
          status: string;
        }>;
        backfillJobsByStatus: Record<string, number>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
        resumableBackfillJobCount: number;
        runningBackfillJobCount: number;
        totalBackfillProcessedCount: number;
      };
      suggestedMaintenanceRequests: Array<{
        input: {
          kind: string;
          reason: string;
          requestId: string;
          syncAliases: string[];
          workflowId: string;
          workspaceId: string;
        };
        reason: string;
        successorToolId: string;
        toolId: string;
      }>;
    };
    expect(runningDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          lastError: "transient coordinator failure",
          operatorAction: "retry_backfill",
          staleRunning: true,
          status: "running"
        })
      ],
      backfillJobsByStatus: {
        running: 1
      },
      failedBackfillJobCount: 1,
      maintenanceState: "attention_required",
      pendingBackfillJobCount: 1,
      resumableBackfillJobCount: 1,
      runningBackfillJobCount: 1,
      totalBackfillProcessedCount: 2
    });
    expect(runningDependencyBody.suggestedMaintenanceRequests).toEqual([
      {
        input: {
          kind: "backfill",
          reason: "manual",
          requestId: "workflow-sync-maintenance:wf_sync_manual:backfill:manual",
          syncAliases: ["destination:fld_source_status:fld_account_status"],
          workflowId: "wf_sync_manual",
          workspaceId: "ws_1"
        },
        reason: "attention_required_backfill",
        successorToolId: "requestWorkflowSyncMaintenance",
        toolId: "prepareWorkflowSyncMaintenance"
      }
    ]);

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             last_error = ?,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run("failed", null, "2026-06-06T00:13:00.000Z", "ws_1", "wf_sync_manual");

    const failedDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/dependencies?workspaceId=ws_1&principalId=ops_sync&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    expect(failedDependencyResponse.status).toBe(200);
    const failedDependencyBody = (await failedDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: Array<{
          lastError: string | null;
          operatorAction: string;
          staleRunning: boolean;
          status: string;
        }>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: Array<{
        input: {
          kind: string;
          reason: string;
          requestId: string;
          syncAliases: string[];
          workflowId: string;
          workspaceId: string;
        };
        reason: string;
        successorToolId: string;
        toolId: string;
      }>;
    };
    expect(failedDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          lastError: null,
          operatorAction: "retry_backfill",
          staleRunning: false,
          status: "failed"
        })
      ],
      failedBackfillJobCount: 1,
      maintenanceState: "attention_required",
      pendingBackfillJobCount: 0
    });
    expect(failedDependencyBody.suggestedMaintenanceRequests).toEqual([
      {
        input: {
          kind: "backfill",
          reason: "manual",
          requestId: "workflow-sync-maintenance:wf_sync_manual:backfill:manual",
          syncAliases: ["destination:fld_source_status:fld_account_status"],
          workflowId: "wf_sync_manual",
          workspaceId: "ws_1"
        },
        reason: "attention_required_backfill",
        successorToolId: "requestWorkflowSyncMaintenance",
        toolId: "prepareWorkflowSyncMaintenance"
      }
    ]);

    const prepareSuggestedSyncMaintenance = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: failedDependencyBody.suggestedMaintenanceRequests[0]!.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_sync",
          toolId: failedDependencyBody.suggestedMaintenanceRequests[0]!.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(prepareSuggestedSyncMaintenance.status).toBe(200);
    const prepareSuggestedSyncMaintenanceBody = (await prepareSuggestedSyncMaintenance.json()) as {
      output: {
        kind: string;
        successorInvocation: {
          input: {
            kind: string;
            reason: string;
            requestId: string;
            syncAliases: string[];
            workflowId: string;
            workspaceId: string;
          };
          toolId: string;
        };
      };
      tool: {
        id: string;
        phase: string;
        successorToolId: string | null;
      };
    };
    expect(prepareSuggestedSyncMaintenanceBody.tool).toMatchObject({
      id: "prepareWorkflowSyncMaintenance",
      phase: "preview",
      successorToolId: "requestWorkflowSyncMaintenance"
    });
    expect(prepareSuggestedSyncMaintenanceBody.output).toMatchObject({
      kind: "workflow-maintenance-draft",
      successorInvocation: {
        input: failedDependencyBody.suggestedMaintenanceRequests[0]!.input,
        toolId: "requestWorkflowSyncMaintenance"
      }
    });

    const executeSuggestedSyncMaintenance = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: prepareSuggestedSyncMaintenanceBody.output.successorInvocation.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_sync",
          toolId: prepareSuggestedSyncMaintenanceBody.output.successorInvocation.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(executeSuggestedSyncMaintenance.status).toBe(200);
    expect((await executeSuggestedSyncMaintenance.json()) as {
      output: {
        aliases: string[];
        dependencyKind: string;
        kind: string;
        requestId: string;
        status: string;
        workflowId: string;
        workflowVersionId: string;
      };
      tool: {
        id: string;
        phase: string;
      };
    }).toMatchObject({
      output: {
        aliases: ["destination:fld_source_status:fld_account_status"],
        dependencyKind: "sync",
        kind: "workflow-maintenance-request",
        requestId: "workflow-sync-maintenance:wf_sync_manual:backfill:manual",
        status: "enqueued",
        workflowId: "wf_sync_manual",
        workflowVersionId: "wf_sync_manual:v1"
      },
      tool: {
        id: "requestWorkflowSyncMaintenance",
        phase: "execute"
      }
    });
    expect(aggregateQueue.sent).toHaveLength(2);
    expect(aggregateQueue.sent[1]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        sync: {
          alias: "destination:fld_source_status:fld_account_status"
        },
        trigger: {
          kind: "backfill",
          reason: "manual"
        },
        workflowId: "wf_sync_manual",
        workflowVersionId: "wf_sync_manual:v1"
      },
      workspaceId: "ws_1"
    });

    const targetScopedRecompute = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_sync_manual/sync-maintenance", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          changedFieldIds: ["fld_account"],
          kind: "recompute",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 31,
          principalId: "ops_sync",
          recordId: null,
          requestId: "manual-sync-target-recompute-1",
          targetRecordId: "rec_account_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(targetScopedRecompute.status).toBe(202);
    expect((await targetScopedRecompute.json()) as {
      kind: string;
      requestId: string;
      status: string;
      syncAliases: string[];
      targetRecordId?: string;
      workflowId: string;
      workflowVersionId: string;
    }).toMatchObject({
      kind: "recompute",
      requestId: "manual-sync-target-recompute-1",
      status: "enqueued",
      syncAliases: ["destination:fld_source_status:fld_account_status"],
      targetRecordId: "rec_account_1",
      workflowId: "wf_sync_manual",
      workflowVersionId: "wf_sync_manual:v1"
    });
    expect(aggregateQueue.sent).toHaveLength(3);
    expect(aggregateQueue.sent[2]).toMatchObject({
      eventId: "manual-sync-recompute:manual-sync-target-recompute-1",
      kind: "aggregate-maintenance",
      payload: {
        trigger: {
          changedFieldIds: ["fld_account"],
          eventId: "manual-sync-recompute:manual-sync-target-recompute-1",
          eventType: "workflow.sync.manual_recompute",
          kind: "recompute",
          recordId: null,
          targetRecordId: "rec_account_1"
        }
      },
      workspaceId: "ws_1"
    });

    const duplicate = await request();
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as { message: string }).toMatchObject({
      message:
        "Sync maintenance request manual-sync-backfill-1 was already accepted for workflow wf_sync_manual."
    });

    db.inner
      .prepare(
        `INSERT INTO workflow_backfill_jobs (
           id,
           workspace_id,
           workflow_id,
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
           created_at,
           updated_at,
           completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "wbf:ws_1:wf_sync_manual:v1:sync:destination:fld_source_status:fld_account_status:manual-replacement",
        "ws_1",
        "wf_sync_manual",
        "wf_sync_manual:v1",
        "sync",
        "destination:fld_source_status:fld_account_status",
        "manual-replacement",
        "queued",
        250,
        null,
        0,
        0,
        null,
        "2026-06-06T00:14:00.000Z",
        "2026-06-06T00:14:00.000Z",
        null
      );

    const supersedeResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/backfill-jobs/wbf:ws_1:wf_sync_manual:v1:sync:destination:fld_source_status:fld_account_status:manual/disposition",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            disposition: "superseded",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 31,
            principalId: "ops_sync",
            reason: "replacement backfill covers the same dependency after recipe edit",
            supersededByJobId:
              "wbf:ws_1:wf_sync_manual:v1:sync:destination:fld_source_status:fld_account_status:manual-replacement",
            workspaceId: "ws_1"
          })
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(supersedeResponse.status).toBe(202);
    expect((await supersedeResponse.json()) as {
      status: string;
      supersededByJobId: string;
    }).toMatchObject({
      status: "superseded",
      supersededByJobId:
        "wbf:ws_1:wf_sync_manual:v1:sync:destination:fld_source_status:fld_account_status:manual-replacement"
    });

    const supersededDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_sync_manual/dependencies?workspaceId=ws_1&principalId=ops_sync&permissionScopeHash=scope:table:tbl_1&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );
    expect(supersededDependencyResponse.status).toBe(200);
    const supersededDependencyBody = (await supersededDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: unknown[];
        intentionallyClosedBackfillJobs: Array<{
          operatorAction: string;
          operatorActorPrincipalId: string;
          operatorReason: string;
          status: string;
          supersededByJobId: string;
        }>;
        pendingBackfillJobCount: number;
        supersededBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: unknown[];
    };
    expect(supersededDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [],
      intentionallyClosedBackfillJobs: [
        expect.objectContaining({
          operatorAction: "superseded_backfill",
          operatorActorPrincipalId: "ops_sync",
          operatorReason: "replacement backfill covers the same dependency after recipe edit",
          status: "superseded",
          supersededByJobId:
            "wbf:ws_1:wf_sync_manual:v1:sync:destination:fld_source_status:fld_account_status:manual-replacement"
        })
      ],
      pendingBackfillJobCount: 2,
      supersededBackfillJobCount: 1
    });
    expect(supersededDependencyBody.suggestedMaintenanceRequests).toEqual([]);
  });

  it("enqueues manual lookup backfill requests through workflow operator ingress with service identity and idempotency", async () => {
    const { aggregateQueue, db, env } = createEnv();
    insertAccountsLookupMaintenanceSchema(db);
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1",
      tableId: "tbl_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account_name",
      fieldKey: "account_name",
      fieldType: "text.single_line",
      recordId: "rec_account_1",
      tableId: "tbl_accounts",
      value: "Acme"
    });
    insertWorkflow(db, {
      definition: createLookupMaintenanceWorkflowDefinition({
        workflowId: "wf_lookup_manual"
      }),
      name: "Lookup Manual",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_lookup_manual",
      workflowKey: "lookup-manual"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_lookup_ops",
      workspaceId: "ws_1",
      principalId: "ops_lookup",
      policyRevision: 33,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_lookup_service",
      workspaceId: "ws_1",
      principalId: "wf_lookup_manual_service",
      policyRevision: 33,
      schemaEpoch: 0,
      scopeHash: "scope:wf:lookup-manual",
      commandTypes: ["cell.set"],
      fields: {
        fld_ticket_account_name: {
          agent: false,
          fieldId: "fld_ticket_account_name",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const request = async (requestId: string) =>
      handleFetch(
        new Request("https://example.test/v1/workflows/wf_lookup_manual/lookup-maintenance", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            kind: "backfill",
            lookupAliases: ["ticket_account_name"],
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 33,
            principalId: "ops_lookup",
            reason: "manual",
            requestId,
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

    const first = await request("manual-lookup-backfill-1");
    expect(first.status).toBe(202);
    expect((await first.json()) as {
      kind: string;
      lookupAliases: string[];
      requestId: string;
      status: string;
      workflowId: string;
      workflowVersionId: string;
    }).toMatchObject({
      kind: "backfill",
      lookupAliases: ["ticket_account_name"],
      requestId: "manual-lookup-backfill-1",
      status: "enqueued",
      workflowId: "wf_lookup_manual",
      workflowVersionId: "wf_lookup_manual:v1"
    });

    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        lookup: {
          alias: "ticket_account_name",
          dependencyFieldIds: ["fld_account"],
          lookupSource: {
            kind: "related_record",
            resolverAlias: "account_lookup",
            sourceFieldId: "fld_account"
          },
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceTableId: "tbl_1",
          targetFieldId: "fld_ticket_account_name",
          valueFieldId: "fld_account_name"
        },
        trigger: {
          kind: "backfill",
          reason: "manual"
        },
        workflowId: "wf_lookup_manual",
        workflowVersionId: "wf_lookup_manual:v1"
      },
      workspaceId: "ws_1"
    });

    const receipt = db.inner
      .prepare(
        `SELECT receipt_json
         FROM idempotency_receipts
         WHERE scope_key = ? AND idempotency_key = ?`
      )
      .get(
        "workflow.lookup-maintenance:ws_1:wf_lookup_manual",
        "manual-lookup-backfill-1"
      ) as { receipt_json: string };
    expect(JSON.parse(receipt.receipt_json)).toMatchObject({
      kind: "backfill",
      lookupAliases: ["ticket_account_name"],
      requestedBy: "ops_lookup",
      workflowId: "wf_lookup_manual"
    });

    const backfillJob = db.inner
      .prepare(
        `SELECT dependency_alias, dependency_kind, reason, status
         FROM workflow_backfill_jobs
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .get("ws_1", "wf_lookup_manual") as {
      dependency_alias: string;
      dependency_kind: string;
      reason: string;
      status: string;
    };
    expect(backfillJob).toMatchObject({
      dependency_alias: "ticket_account_name",
      dependency_kind: "lookup",
      reason: "manual",
      status: "queued"
    });

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             last_error = ?,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run(
        "failed",
        "lookup coordinator failed",
        "2026-06-06T00:13:00.000Z",
        "ws_1",
        "wf_lookup_manual"
      );

    const failedDependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_lookup_manual/dependencies?workspaceId=ws_1&principalId=ops_lookup&permissionScopeHash=scope:table:tbl_1&policyRevision=33"
      ),
      env,
      {} as ExecutionContext
    );
    expect(failedDependencyResponse.status).toBe(200);
    const failedDependencyBody = (await failedDependencyResponse.json()) as {
      summary: {
        attentionRequiredBackfillJobs: Array<{
          dependencyAlias: string;
          dependencyKind: string;
          lastError: string | null;
          operatorAction: string;
          reason: string;
          staleRunning: boolean;
          status: string;
        }>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
      };
      suggestedMaintenanceRequests: Array<{
        input: {
          kind: string;
          lookupAliases: string[];
          reason: string;
          requestId: string;
          workflowId: string;
          workspaceId: string;
        };
        reason: string;
        successorToolId: string;
        toolId: string;
      }>;
    };
    expect(failedDependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          dependencyAlias: "ticket_account_name",
          dependencyKind: "lookup",
          lastError: "lookup coordinator failed",
          operatorAction: "retry_backfill",
          reason: "manual",
          staleRunning: false,
          status: "failed"
        })
      ],
      failedBackfillJobCount: 1,
      maintenanceState: "attention_required",
      pendingBackfillJobCount: 0
    });
    expect(failedDependencyBody.suggestedMaintenanceRequests).toEqual([
      {
        input: {
          kind: "backfill",
          lookupAliases: ["ticket_account_name"],
          reason: "manual",
          requestId: "workflow-lookup-maintenance:wf_lookup_manual:backfill:manual",
          workflowId: "wf_lookup_manual",
          workspaceId: "ws_1"
        },
        reason: "attention_required_backfill",
        successorToolId: "requestWorkflowLookupMaintenance",
        toolId: "prepareWorkflowLookupMaintenance"
      }
    ]);

    db.inner
      .prepare(
        `UPDATE workflow_backfill_jobs
         SET status = ?,
             last_error = NULL,
             updated_at = ?
         WHERE workspace_id = ? AND workflow_id = ?`
      )
      .run("queued", "2026-06-06T00:14:00.000Z", "ws_1", "wf_lookup_manual");

    await handleQueueBatch(
      createBatch([aggregateQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    const lookupCell = db.inner
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_1", "rec_ticket_1", "fld_ticket_account_name") as {
      value_json: string;
    };
    expect(JSON.parse(lookupCell.value_json)).toMatchObject({
      raw: "Acme",
      valueType: "computed.readonly"
    });
    const ledgerRow = db.inner
      .prepare(
        `SELECT metadata_json
         FROM event_ledger
         WHERE workspace_id = ? AND table_id = ? AND command_id LIKE ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get("ws_1", "tbl_1", "cmd:lookup-maintenance:%") as { metadata_json: string };
    expect(JSON.parse(ledgerRow.metadata_json)).toMatchObject({
      actor: {
        mode: "workflow",
        principalId: "wf_lookup_manual_service"
      },
      coordinatorOwnedMutation: true,
      permissionScopeHash: "scope:wf:lookup-manual",
      permissionsVersion: 33,
      schemaEpoch: 0
    });

    const executeTool = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            kind: "backfill",
            lookupAliases: ["ticket_account_name"],
            reason: "manual",
            requestId: "manual-lookup-backfill-tool-1",
            workflowId: "wf_lookup_manual",
            workspaceId: "ws_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 33,
          principalId: "ops_lookup",
          toolId: "requestWorkflowLookupMaintenance",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(executeTool.status).toBe(200);
    expect((await executeTool.json()) as {
      output: {
        aliases: string[];
        dependencyKind: string;
        kind: string;
        requestId: string;
        status: string;
        workflowId: string;
        workflowVersionId: string;
      };
      tool: {
        id: string;
        phase: string;
      };
    }).toMatchObject({
      output: {
        aliases: ["ticket_account_name"],
        dependencyKind: "lookup",
        kind: "workflow-maintenance-request",
        requestId: "manual-lookup-backfill-tool-1",
        status: "enqueued",
        workflowId: "wf_lookup_manual",
        workflowVersionId: "wf_lookup_manual:v1"
      },
      tool: {
        id: "requestWorkflowLookupMaintenance",
        phase: "execute"
      }
    });
    expect(aggregateQueue.sent).toHaveLength(2);

    const duplicate = await request("manual-lookup-backfill-1");
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()) as { message: string }).toMatchObject({
      message:
        "Lookup maintenance request manual-lookup-backfill-1 was already accepted for workflow wf_lookup_manual."
    });
  });

  it("rejects manual lookup-maintenance ingress for invalid input, unauthorized operators, missing identity, and paused workflows", async () => {
    const { db, env } = createEnv();
    insertAccountsLookupMaintenanceSchema(db);
    insertWorkflow(db, {
      definition: createLookupMaintenanceWorkflowDefinition({
        workflowId: "wf_lookup_validation"
      }),
      name: "Lookup Validation",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_lookup_validation",
      workflowKey: "lookup-validation"
    });
    insertWorkflow(db, {
      definition: createLookupMaintenanceWorkflowDefinition({
        omitPrincipal: true,
        workflowId: "wf_lookup_missing_principal"
      }),
      name: "Lookup Missing Principal",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_lookup_missing_principal",
      workflowKey: "lookup-missing-principal"
    });
    insertWorkflow(db, {
      definition: createLookupMaintenanceWorkflowDefinition({
        status: "paused",
        workflowId: "wf_lookup_paused"
      }),
      name: "Lookup Paused",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_lookup_paused",
      workflowKey: "lookup-paused"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_lookup_validation",
      workspaceId: "ws_1",
      principalId: "ops_lookup_validation",
      policyRevision: 34,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_lookup_denied",
      workspaceId: "ws_1",
      principalId: "ops_lookup_denied",
      policyRevision: 34,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["record.create"],
      fields: {}
    });

    const request = (workflowId: string, body: Record<string, unknown>) =>
      handleFetch(
        new Request(`https://example.test/v1/workflows/${workflowId}/lookup-maintenance`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            kind: "backfill",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 34,
            principalId: "ops_lookup_validation",
            workspaceId: "ws_1",
            ...body
          })
        }),
        env,
        {} as ExecutionContext
      );

    const invalidKind = await request("wf_lookup_validation", {
      kind: "repair",
      requestId: "manual-lookup-invalid-kind"
    });
    expect(invalidKind.status).toBe(400);
    expect((await invalidKind.json()) as { message: string }).toMatchObject({
      message: "kind must be either backfill or recompute."
    });

    const invalidAliasShape = await request("wf_lookup_validation", {
      lookupAliases: "ticket_account_name",
      requestId: "manual-lookup-invalid-alias-shape"
    });
    expect(invalidAliasShape.status).toBe(400);
    expect((await invalidAliasShape.json()) as { message: string }).toMatchObject({
      message: "lookupAliases must be an array of strings when provided."
    });

    const invalidAliasEntry = await request("wf_lookup_validation", {
      lookupAliases: ["ticket_account_name", ""],
      requestId: "manual-lookup-invalid-alias-entry"
    });
    expect(invalidAliasEntry.status).toBe(400);
    expect((await invalidAliasEntry.json()) as { message: string }).toMatchObject({
      message: "lookupAliases entries must all be non-empty strings."
    });

    const missingAlias = await request("wf_lookup_validation", {
      lookupAliases: ["missing_lookup"],
      requestId: "manual-lookup-missing-alias"
    });
    expect(missingAlias.status).toBe(400);
    expect((await missingAlias.json()) as { message: string }).toMatchObject({
      message: "Workflow wf_lookup_validation does not define lookup alias missing_lookup."
    });

    const invalidTargetRecordScope = await request("wf_lookup_validation", {
      requestId: "manual-lookup-backfill-target-scope",
      targetRecordId: "rec_account_1"
    });
    expect(invalidTargetRecordScope.status).toBe(400);
    expect((await invalidTargetRecordScope.json()) as { message: string }).toMatchObject({
      message: "targetRecordId can only be provided for recompute lookup maintenance."
    });

    const missingPrincipal = await request("wf_lookup_missing_principal", {
      requestId: "manual-lookup-missing-principal"
    });
    expect(missingPrincipal.status).toBe(400);
    expect((await missingPrincipal.json()) as { message: string }).toMatchObject({
      message:
        "Workflow wf_lookup_missing_principal version wf_lookup_missing_principal:v1 is missing explicit workflow service identity metadata."
    });

    const paused = await request("wf_lookup_paused", {
      requestId: "manual-lookup-paused"
    });
    expect(paused.status).toBe(400);
    expect((await paused.json()) as { message: string }).toMatchObject({
      message: "Workflow wf_lookup_paused is paused and cannot accept lookup maintenance requests."
    });

    const denied = await request("wf_lookup_validation", {
      principalId: "ops_lookup_denied",
      requestId: "manual-lookup-denied"
    });
    expect(denied.status).toBe(403);
    expect((await denied.json()) as { error: string }).toMatchObject({
      error: "forbidden"
    });
  });

  it("rejects manual sync-maintenance ingress for undefined aliases, missing service identity, and paused workflows", async () => {
    const { db, env } = createEnv();

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
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1",
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      }
    });
    insertField(db, {
      fieldId: "fld_source_status",
      fieldKey: "source_status",
      fieldType: "text.single_line",
      label: "Source Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_account_status",
      fieldKey: "account_status",
      fieldType: "text.single_line",
      label: "Account Status",
      tableId: "tbl_accounts"
    });

    const syncDefinition = (overrides: Record<string, unknown> = {}) => ({
      actions: [
        {
          input: {
            resolverAlias: "destination",
            sourceFieldId: "fld_source_status",
            targetFieldId: "fld_account_status"
          },
          operatorId: "sync_related_field"
        }
      ],
      conditions: [],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destination",
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      principal: {
        policyRevision: 32,
        principalId: "wf_sync_validation_service",
        schemaEpoch: 0,
        scopeHash: "scope:wf:sync-validation"
      },
      trigger: {
        match: {
          tableId: "tbl_1"
        },
        operatorId: "field_changed"
      },
      workflowId: "wf_sync_validation",
      ...overrides
    });

    insertWorkflow(db, {
      definition: syncDefinition(),
      name: "Sync Invalid Alias",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_sync_invalid_alias",
      workflowKey: "sync-invalid-alias"
    });
    insertWorkflow(db, {
      definition: syncDefinition({
        principal: undefined,
        workflowId: "wf_sync_missing_principal"
      }),
      name: "Sync Missing Principal",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_sync_missing_principal",
      workflowKey: "sync-missing-principal"
    });
    insertWorkflow(db, {
      definition: syncDefinition({
        metadata: {
          relatedTableResolvers: [
            {
              alias: "destination",
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "paused",
          tableId: "tbl_1"
        },
        workflowId: "wf_sync_paused"
      }),
      name: "Sync Paused",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_sync_paused",
      workflowKey: "sync-paused"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_sync_validation",
      workspaceId: "ws_1",
      principalId: "ops_sync_validation",
      policyRevision: 32,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const request = (workflowId: string, body: Record<string, unknown>) =>
      handleFetch(
        new Request(`https://example.test/v1/workflows/${workflowId}/sync-maintenance`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            kind: "backfill",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 32,
            principalId: "ops_sync_validation",
            workspaceId: "ws_1",
            ...body
          })
        }),
        env,
        {} as ExecutionContext
      );

    const invalidAliasShape = await request("wf_sync_invalid_alias", {
      requestId: "manual-sync-invalid-alias-shape",
      syncAliases: "destination:fld_source_status:fld_account_status"
    });
    expect(invalidAliasShape.status).toBe(400);
    expect((await invalidAliasShape.json()) as { message: string }).toMatchObject({
      message: "syncAliases must be an array of strings when provided."
    });

    const invalidAliasEntry = await request("wf_sync_invalid_alias", {
      requestId: "manual-sync-invalid-alias-entry",
      syncAliases: ["destination:fld_source_status:fld_account_status", ""]
    });
    expect(invalidAliasEntry.status).toBe(400);
    expect((await invalidAliasEntry.json()) as { message: string }).toMatchObject({
      message: "syncAliases entries must all be non-empty strings."
    });

    const invalidAlias = await request("wf_sync_invalid_alias", {
      requestId: "manual-sync-invalid-alias",
      syncAliases: ["missing_sync"]
    });
    expect(invalidAlias.status).toBe(400);
    expect((await invalidAlias.json()) as { message: string }).toMatchObject({
      message: "Workflow wf_sync_invalid_alias does not define sync alias missing_sync."
    });

    const invalidTargetRecordScope = await request("wf_sync_invalid_alias", {
      requestId: "manual-sync-backfill-target-scope",
      targetRecordId: "rec_account_1"
    });
    expect(invalidTargetRecordScope.status).toBe(400);
    expect((await invalidTargetRecordScope.json()) as { message: string }).toMatchObject({
      message: "targetRecordId can only be provided for recompute sync maintenance."
    });

    const missingPrincipal = await request("wf_sync_missing_principal", {
      requestId: "manual-sync-missing-principal"
    });
    expect(missingPrincipal.status).toBe(400);
    expect((await missingPrincipal.json()) as { message: string }).toMatchObject({
      message:
        "Workflow wf_sync_missing_principal version wf_sync_missing_principal:v1 is missing explicit workflow service identity metadata."
    });

    const paused = await request("wf_sync_paused", {
      requestId: "manual-sync-paused"
    });
    expect(paused.status).toBe(400);
    expect((await paused.json()) as { message: string }).toMatchObject({
      message: "Workflow wf_sync_paused is paused and cannot accept sync maintenance requests."
    });
  });

  it("rejects manual aggregate-maintenance ingress when requested aggregate aliases are undefined", async () => {
    const { db, env } = createEnv();

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
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1",
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      }
    });
    insertField(db, {
      fieldId: "fld_open_ticket_count",
      fieldKey: "open_ticket_count",
      fieldType: "computed.readonly",
      label: "Open Ticket Count",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_status"],
        expression: "aggregate.account_open_ticket_count",
        resultValueType: "number"
      }
    });
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "open_ticket_count",
              dependencyFieldIds: ["fld_status"],
              groupingSource: {
                kind: "related_record",
                resolverAlias: "account"
              },
              operationId: "count_records",
              sourceRelationPath: "relatedTables.account",
              targetFieldId: "fld_open_ticket_count"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "account",
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "published",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 27,
          principalId: "wf_aggregate_invalid_service",
          schemaEpoch: 0,
          scopeHash: "scope:wf:aggregate-invalid"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_aggregate_invalid"
      },
      name: "Aggregate Invalid",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_aggregate_invalid",
      workflowKey: "aggregate-invalid"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_aggregate_invalid",
      workspaceId: "ws_1",
      principalId: "ops_aggregate",
      policyRevision: 27,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_aggregate_invalid/aggregate-maintenance", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          aggregateAliases: ["missing_alias"],
          kind: "recompute",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 27,
          principalId: "ops_aggregate",
          requestId: "manual-recompute-1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    const invalidAliasShape = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_aggregate_invalid/aggregate-maintenance", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          aggregateAliases: "open_ticket_count",
          kind: "recompute",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 27,
          principalId: "ops_aggregate",
          requestId: "manual-recompute-invalid-alias-shape",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidAliasShape.status).toBe(400);
    expect((await invalidAliasShape.json()) as { message: string }).toMatchObject({
      message: "aggregateAliases must be an array of strings when provided."
    });

    const invalidAliasEntry = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_aggregate_invalid/aggregate-maintenance", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          aggregateAliases: ["open_ticket_count", ""],
          kind: "recompute",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 27,
          principalId: "ops_aggregate",
          requestId: "manual-recompute-invalid-alias-entry",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidAliasEntry.status).toBe(400);
    expect((await invalidAliasEntry.json()) as { message: string }).toMatchObject({
      message: "aggregateAliases entries must all be non-empty strings."
    });

    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toMatchObject({
      message: "Workflow wf_aggregate_invalid does not define aggregate alias missing_alias."
    });
  });

  it("rejects manual aggregate-maintenance ingress when the published workflow omits explicit service identity metadata", async () => {
    const { db, env } = createEnv();

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
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1",
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      }
    });
    insertField(db, {
      fieldId: "fld_open_ticket_count",
      fieldKey: "open_ticket_count",
      fieldType: "computed.readonly",
      label: "Open Ticket Count",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_status"],
        expression: "aggregate.account_open_ticket_count",
        resultValueType: "number"
      }
    });
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "open_ticket_count",
              dependencyFieldIds: ["fld_status"],
              groupingSource: {
                kind: "related_record",
                resolverAlias: "account"
              },
              operationId: "count_records",
              sourceRelationPath: "relatedTables.account",
              targetFieldId: "fld_open_ticket_count"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "account",
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "published",
          tableId: "tbl_1"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_aggregate_missing_principal"
      },
      name: "Aggregate Missing Principal",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_aggregate_missing_principal",
      workflowKey: "aggregate-missing-principal"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_aggregate_missing_principal",
      workspaceId: "ws_1",
      principalId: "ops_aggregate",
      policyRevision: 28,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_aggregate_missing_principal/aggregate-maintenance",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            aggregateAliases: ["open_ticket_count"],
            kind: "backfill",
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 28,
            principalId: "ops_aggregate",
            requestId: "manual-backfill-missing-principal",
            workspaceId: "ws_1"
          })
        }
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { message: string }).toMatchObject({
      message:
        "Workflow wf_aggregate_missing_principal version wf_aggregate_missing_principal:v1 is missing explicit workflow service identity metadata."
    });
  });

  it("returns persisted workflow definition metadata through the worker read ingress", async () => {
    const { db, env } = createEnv();
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
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            eventTypes: ["record_updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record_updated"
        },
        conditions: [
          {
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
            },
            operatorId: "is_not_empty"
          },
          {
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
              right: "ready"
            },
            operatorId: "equals"
          }
        ],
        actions: [
          {
            input: {
              fieldId: "fld_owner",
              tableId: "tbl_1",
              value: "usr_ops"
            },
            operatorId: "record.patch"
          }
        ],
        workflowId: "wf_definition_detail"
      },
      name: "Workflow Detail",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_definition_detail",
      workflowKey: "workflow-detail"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_definition_read",
      workspaceId: "ws_1",
      principalId: "usr_workflow_definition",
      policyRevision: 38,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_definition_detail/definition?workspaceId=ws_1&principalId=usr_workflow_definition&permissionScopeHash=scope:table:tbl_1&policyRevision=38"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      conditionMetadata: [
        {
          diagnostics: [],
          index: 0,
          operator: supportedConditionOperatorManifests(["is_not_empty"])[0],
          operatorId: "is_not_empty",
          referencedBindingNames: ["row.owner"],
          resolvedBindings: [
            {
              binding: "row.owner",
              fieldId: "fld_owner",
              fieldKey: "owner",
              fieldType: "principal.user",
              supportedOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
              supportedOperators: supportedConditionOperatorManifests([
                "equals",
                "not_equals",
                "is_empty",
                "is_not_empty"
              ]),
              template: {
                fieldIdPath: "row.owner.fieldId",
                fieldTypePath: "row.owner.fieldType",
                valuePath: "row.owner.value"
              }
            }
          ]
        },
        {
          diagnostics: [],
          index: 1,
          operator: supportedConditionOperatorManifests(["equals"])[0],
          operatorId: "equals",
          referencedBindingNames: ["row.fields.status"],
          resolvedBindings: [
            {
              binding: "row.fields.status",
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "status.semantic",
              template: {
                fieldIdPath: "row.fields.status.fieldId",
                fieldTypePath: "row.fields.status.fieldType",
                valuePath: "row.fields.status.value"
              }
            }
          ]
        }
      ],
      currentVersion: 1,
      definition: {
        actions: [
          {
            input: {
              fieldId: "fld_owner",
              tableId: "tbl_1",
              value: "usr_ops"
            },
            operatorId: "record.patch"
          }
        ],
        conditions: [
          {
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
            },
            operatorId: "is_not_empty"
          },
          {
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
              right: "ready"
            },
            operatorId: "equals"
          }
        ],
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            eventTypes: ["record_updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record_updated"
        },
        workflowId: "wf_definition_detail"
      },
      effectiveVersion: 1,
      publishedAt: "2026-06-06T00:00:00.000Z",
      status: "paused",
      triggerTableId: "tbl_1",
      workflow: {
        bindings: {
          "row.owner": {
            binding: "row.owner",
            fieldId: "fld_owner",
            fieldKey: "owner",
            fieldType: "principal.user"
          },
          "row.fields.status": {
            binding: "row.fields.status",
            fieldId: "fld_status",
            fieldKey: "status",
            fieldType: "status.semantic"
          }
        }
      },
      workflowId: "wf_definition_detail",
      workflowKey: "workflow-detail",
      workflowName: "Workflow Detail",
      workflowVersionId: "wf_definition_detail:v1",
      workspaceId: "ws_1"
    });
  });

  it("inspects saved template.input-shaped workflow conditions through the worker read ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [
          {
            input: {
              left: {
                path: "row.fields.status.value"
              },
              right: "qualified"
            },
            operatorId: "equals"
          }
        ],
        metadata: {
          status: "published"
        },
        trigger: {
          match: {
            eventTypes: ["record_updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record_updated"
        },
        workflowId: "wf_template_input_detail"
      },
      name: "Template Input Detail",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_template_input_detail",
      workflowKey: "template-input-detail"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_template_input_read",
      workspaceId: "ws_1",
      principalId: "usr_workflow_template_input",
      policyRevision: 39,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_template_input_detail/definition?workspaceId=ws_1&principalId=usr_workflow_template_input&permissionScopeHash=scope:table:tbl_1&policyRevision=39"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      conditionMetadata: [
        {
          diagnostics: [],
          index: 0,
          operator: supportedConditionOperatorManifests(["equals"])[0],
          operatorId: "equals",
          referencedBindingNames: ["row.fields.status"],
          resolvedBindings: [
            {
              binding: "row.fields.status",
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "status.semantic",
              supportedOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
              supportedOperators: supportedConditionOperatorManifests([
                "equals",
                "not_equals",
                "is_empty",
                "is_not_empty"
              ]),
              template: {
                fieldIdPath: "row.fields.status.fieldId",
                fieldTypePath: "row.fields.status.fieldType",
                valuePath: "row.fields.status.value"
              }
            }
          ]
        }
      ],
      definition: {
        actions: [],
        conditions: [
          {
            input: {
              left: {
                path: "row.fields.status.value"
              },
              right: "qualified"
            },
            operatorId: "equals"
          }
        ],
        metadata: {
          status: "published"
        },
        trigger: {
          match: {
            eventTypes: ["record_updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record_updated"
        },
        workflowId: "wf_template_input_detail"
      },
      workflowId: "wf_template_input_detail",
      workflowKey: "template-input-detail",
      workflowName: "Template Input Detail"
    });
  });

  it("routes permission-scoped workflow definition reads through the inspectWorkflowDefinition agent tool", async () => {
    const { db, env } = createEnv();
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
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            eventTypes: ["record_updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record_updated"
        },
        conditions: [
          {
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
            },
            operatorId: "is_not_empty"
          },
          {
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
              right: "ready"
            },
            operatorId: "equals"
          }
        ],
        actions: [
          {
            input: {
              fieldId: "fld_owner",
              tableId: "tbl_1",
              value: "usr_ops"
            },
            operatorId: "record.patch"
          }
        ],
        workflowId: "wf_definition_agent"
      },
      name: "Workflow Agent Detail",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_definition_agent",
      workflowKey: "workflow-agent-detail"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_definition_agent",
      workspaceId: "ws_1",
      principalId: "agt_workflow_definition",
      policyRevision: 42,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
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
      }
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_definition_agent/definition?workspaceId=ws_1&principalId=agt_workflow_definition&permissionScopeHash=scope:table:tbl_1&policyRevision=42"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_definition_agent"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 42,
          principalId: "agt_workflow_definition",
          toolId: "inspectWorkflowDefinition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        workflow: Record<string, unknown>;
      };
    };

    expect(agentBody.output).toEqual({
      kind: "workflow-definition-inspection",
      workflow: directBody
    });
  });

  it("rejects workflow definition metadata reads when protected fields are referenced", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        trigger: {
          match: {
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record.updated"
        },
        conditions: [],
        actions: [
          {
            input: {
              fieldId: "fld_secret",
              tableId: "tbl_1",
              value: "restricted"
            },
            operatorId: "record.patch"
          }
        ],
        workflowId: "wf_definition_denied"
      },
      name: "Workflow Secret",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_definition_denied",
      workflowKey: "workflow-secret"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_definition_denied",
      workspaceId: "ws_1",
      principalId: "usr_workflow_definition_denied",
      policyRevision: 39,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_definition_denied/definition?workspaceId=ws_1&principalId=usr_workflow_definition_denied&permissionScopeHash=scope:table:tbl_1&policyRevision=39"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { protectedFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        protectedFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("rejects inspectWorkflowDefinition agent tool reads when protected fields are referenced", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        trigger: {
          match: {
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record.updated"
        },
        conditions: [],
        actions: [
          {
            input: {
              fieldId: "fld_secret",
              tableId: "tbl_1",
              value: "restricted"
            },
            operatorId: "record.patch"
          }
        ],
        workflowId: "wf_definition_agent_denied"
      },
      name: "Workflow Agent Secret",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_definition_agent_denied",
      workflowKey: "workflow-agent-secret"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_definition_agent_denied",
      workspaceId: "ws_1",
      principalId: "agt_workflow_definition_denied",
      policyRevision: 43,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_definition_agent_denied"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 43,
          principalId: "agt_workflow_definition_denied",
          toolId: "inspectWorkflowDefinition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { protectedFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        protectedFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("denies workflow operations ingress when the principal lacks workflow command access", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_history_denied"
      },
      name: "History Denied",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_history_denied",
      workflowKey: "history-denied"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_history_denied",
      workspaceId: "ws_1",
      principalId: "usr_view_only",
      policyRevision: 22,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["record.create"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_history_denied/history?workspaceId=ws_1&principalId=usr_view_only&permissionScopeHash=scope:table:tbl_1&policyRevision=22"
      ),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "forbidden"
    });
  });

  it("denies workflow observability agent tools when the principal lacks workflow command access", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_history_tool_denied"
      },
      name: "History Tool Denied",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_history_tool_denied",
      workflowKey: "history-tool-denied"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_history_tool_denied",
      workspaceId: "ws_1",
      principalId: "usr_history_tool_denied",
      policyRevision: 32,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["record.create"],
      fields: {}
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_history_tool_denied"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 32,
          principalId: "usr_history_tool_denied",
          toolId: "readWorkflowHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "forbidden"
    });
  });

  it("enqueues dead-letter replay once and rejects duplicate or ineligible replay requests", async () => {
    const { db, deadLetterQueue, env } = createEnv();
    insertWorkflow(db, {
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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_replay_operator",
      workspaceId: "ws_1",
      principalId: "ops_2",
      policyRevision: 23,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.pause"],
      fields: {}
    });
    insertWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:12:00.000Z",
      status: "dead_lettered",
      workflowId: "wf_replay",
      workflowRunId: "wfr_replay_1"
    });
    insertWorkflowRunStep(db, {
      lastErrorCode: "record_not_found:rec_missing",
      status: "dead_lettered",
      stepId: "wfr_replay_1:step:0",
      workflowRunId: "wfr_replay_1"
    });
    insertWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_1",
      workflowStepId: "wfr_replay_1:step:0"
    });
    insertWorkflowRun(db, {
      status: "completed",
      workflowId: "wf_replay",
      workflowRunId: "wfr_replay_2"
    });
    insertWorkflowRunStep(db, {
      status: "completed",
      stepId: "wfr_replay_2:step:0",
      workflowRunId: "wfr_replay_2"
    });
    insertWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_2",
      workflowStepId: "wfr_replay_2:step:0"
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
    expect(deadLetterQueue.sent[0]).toMatchObject({
      kind: "dead-letter-reprocessor",
      payload: {
        deadLetterId: "wdl:wfr_replay_1:step:0"
      },
      workspaceId: "ws_1"
    });

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
  });

  it("exposes dead-letter replay through preview and execute agent-tool ingress with the same runtime behavior", async () => {
    const { db, deadLetterQueue, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_replay_tool"
      },
      name: "Replay Tool",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_replay_tool",
      workflowKey: "replay-tool"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_replay_tool",
      workspaceId: "ws_1",
      principalId: "ops_tool",
      policyRevision: 24,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.pause"],
      fields: {}
    });
    insertWorkflowRun(db, {
      deadLetteredAt: "2026-06-06T00:12:00.000Z",
      status: "dead_lettered",
      workflowId: "wf_replay_tool",
      workflowRunId: "wfr_replay_tool_1"
    });
    insertWorkflowRunStep(db, {
      lastErrorCode: "record_not_found:rec_missing",
      status: "dead_lettered",
      stepId: "wfr_replay_tool_1:step:0",
      workflowRunId: "wfr_replay_tool_1"
    });
    insertWorkflowDeadLetter(db, {
      workflowRunId: "wfr_replay_tool_1",
      workflowStepId: "wfr_replay_tool_1:step:0"
    });

    const preview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_tool_1:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 24,
          principalId: "ops_tool",
          toolId: "prepareWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      output: {
        kind: string;
        request: {
          deadLetterId: string;
          replayRequestId: string;
        };
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    expect(previewBody.tool).toEqual({
      id: "prepareWorkflowDeadLetterReplay",
      phase: "preview",
      scope: "workflow",
      successorToolId: "requestWorkflowDeadLetterReplay"
    });
    expect(previewBody.output).toMatchObject({
      kind: "workflow-dead-letter-replay-draft",
      request: {
        deadLetterId: "wdl:wfr_replay_tool_1:step:0",
        replayRequestId: "dead-letter-replay:wdl:wfr_replay_tool_1:step:0"
      }
    });

    const execute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_tool_1:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 24,
          principalId: "ops_tool",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(execute.status).toBe(200);
    const executeBody = (await execute.json()) as {
      output: {
        deadLetterId: string;
        kind: string;
        replayRequestId: string;
        status: string;
      };
      tool: {
        id: string;
        phase: string;
      };
    };
    expect(executeBody.tool).toMatchObject({
      id: "requestWorkflowDeadLetterReplay",
      phase: "execute"
    });
    expect(executeBody.output).toEqual({
      deadLetterId: "wdl:wfr_replay_tool_1:step:0",
      kind: "workflow-dead-letter-replay",
      replayRequestId: "dead-letter-replay:wdl:wfr_replay_tool_1:step:0",
      status: "enqueued"
    });
    expect(deadLetterQueue.sent).toHaveLength(1);

    const duplicateExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_tool_1:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 24,
          principalId: "ops_tool",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(duplicateExecute.status).toBe(409);
    const duplicateExecuteBody = (await duplicateExecute.json()) as {
      output: {
        deadLetterId: string;
        kind: string;
        reason: string;
        status: string;
      };
    };
    expect(duplicateExecuteBody.output).toMatchObject({
      deadLetterId: "wdl:wfr_replay_tool_1:step:0",
      kind: "workflow-dead-letter-replay",
      reason: "already_requested",
      status: "rejected"
    });
    expect(deadLetterQueue.sent).toHaveLength(1);

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_replay_tool_denied",
      workspaceId: "ws_1",
      principalId: "ops_tool_denied",
      policyRevision: 25,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: [],
      fields: {}
    });
    const unauthorizedExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            deadLetterId: "wdl:wfr_replay_tool_1:step:0"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 25,
          principalId: "ops_tool_denied",
          toolId: "requestWorkflowDeadLetterReplay",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(unauthorizedExecute.status).toBe(403);
  });

  it("exposes workflow backfill dispositions through preview and execute agent-tool ingress", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_backfill_disposition_tool"
      },
      name: "Backfill Disposition Tool",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_backfill_disposition_tool",
      workflowKey: "backfill-disposition-tool"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_backfill_disposition_tool",
      workspaceId: "ws_1",
      principalId: "ops_backfill_tool",
      policyRevision: 26,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });
    insertWorkflowBackfillJob(db, {
      dependencyAlias: "ticket_rollup",
      dependencyKind: "aggregate",
      jobId: "wbf_failed_disposition_tool",
      lastError: "aggregate worker failed",
      status: "failed",
      updatedAt: "2026-06-06T00:13:00.000Z",
      workflowId: "wf_backfill_disposition_tool"
    });
    insertWorkflowBackfillJob(db, {
      cursor: {
        lastRecordId: "rec_1"
      },
      dependencyAlias: "ticket_sync",
      dependencyKind: "sync",
      jobId: "wbf_stale_disposition_tool",
      processedCount: 2,
      status: "running",
      updatedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_backfill_disposition_tool"
    });
    insertWorkflowBackfillJob(db, {
      dependencyAlias: "ticket_sync",
      dependencyKind: "sync",
      jobId: "wbf_replacement_disposition_tool",
      reason: "manual-replacement",
      status: "queued",
      updatedAt: "2026-06-06T00:14:00.000Z",
      workflowId: "wf_backfill_disposition_tool"
    });

    const dependenciesBefore = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "readWorkflowDependencies",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(dependenciesBefore.status).toBe(200);
    const dependenciesBeforeBody = (await dependenciesBefore.json()) as {
      output: {
        dependencies: {
          summary: {
            attentionRequiredBackfillJobs: Array<{
              operatorAction: string;
              staleRunning: boolean;
              status: string;
            }>;
            failedBackfillJobCount: number;
            staleRunningBackfillJobCount: number;
          };
        };
      };
    };
    expect(dependenciesBeforeBody.output.dependencies.summary).toMatchObject({
      attentionRequiredBackfillJobs: [
        expect.objectContaining({
          operatorAction: "retry_backfill",
          staleRunning: false,
          status: "failed"
        }),
        expect.objectContaining({
          operatorAction: "retry_backfill",
          staleRunning: true,
          status: "running"
        })
      ],
      failedBackfillJobCount: 2,
      staleRunningBackfillJobCount: 1
    });

    const missingReasonPreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "abandoned",
            jobId: "wbf_failed_disposition_tool",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "prepareWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(missingReasonPreview.status).toBe(400);
    expect((await missingReasonPreview.json()) as { message: string }).toMatchObject({
      message: "reason is required for this agent tool."
    });

    const missingSupersedeTargetPreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "superseded",
            jobId: "wbf_stale_disposition_tool",
            reason: "replacement backfill is queued",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "prepareWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(missingSupersedeTargetPreview.status).toBe(400);
    expect((await missingSupersedeTargetPreview.json()) as { message: string }).toMatchObject({
      message: "supersededByJobId is required when superseding a backfill job."
    });

    const executeOnlyToolPreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "abandoned",
            jobId: "wbf_failed_disposition_tool",
            reason: "workflow definition replaced before retry",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "requestWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(executeOnlyToolPreview.status).toBe(400);
    expect((await executeOnlyToolPreview.json()) as { message: string }).toMatchObject({
      message: "Execution-phase agent tools are not exposed on the preview ingress."
    });

    const previewOnlyToolExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "abandoned",
            jobId: "wbf_failed_disposition_tool",
            reason: "workflow definition replaced before retry",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "prepareWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(previewOnlyToolExecute.status).toBe(400);
    expect((await previewOnlyToolExecute.json()) as { message: string }).toMatchObject({
      message: "Only execution-phase agent tools are exposed on the execution ingress."
    });

    const abandonPreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "abandoned",
            jobId: "wbf_failed_disposition_tool",
            reason: "workflow definition replaced before retry",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "prepareWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(abandonPreview.status).toBe(200);
    const abandonPreviewBody = (await abandonPreview.json()) as {
      output: {
        kind: string;
        request: {
          disposition: string;
          jobId: string;
          reason: string;
          workflowId: string;
        };
        successorInvocation: {
          input: Record<string, unknown>;
          toolId: string;
        };
      };
      tool: {
        id: string;
        phase: string;
        successorToolId: string | null;
      };
    };
    expect(abandonPreviewBody.tool).toEqual({
      id: "prepareWorkflowBackfillDisposition",
      phase: "preview",
      scope: "workflow",
      successorToolId: "requestWorkflowBackfillDisposition"
    });
    expect(abandonPreviewBody.output).toMatchObject({
      kind: "workflow-backfill-disposition-draft",
      request: {
        disposition: "abandoned",
        jobId: "wbf_failed_disposition_tool",
        reason: "workflow definition replaced before retry",
        workflowId: "wf_backfill_disposition_tool"
      },
      successorInvocation: {
        toolId: "requestWorkflowBackfillDisposition"
      }
    });

    const abandonExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: abandonPreviewBody.output.successorInvocation.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: abandonPreviewBody.output.successorInvocation.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(abandonExecute.status).toBe(200);
    expect((await abandonExecute.json()) as {
      output: {
        jobId: string;
        kind: string;
        operatorReason: string;
        status: string;
        supersededByJobId: string | null;
      };
      tool: {
        id: string;
        phase: string;
      };
    }).toMatchObject({
      output: {
        jobId: "wbf_failed_disposition_tool",
        kind: "workflow-backfill-disposition",
        operatorReason: "workflow definition replaced before retry",
        status: "abandoned",
        supersededByJobId: null
      },
      tool: {
        id: "requestWorkflowBackfillDisposition",
        phase: "execute"
      }
    });

    const supersedePreview = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            disposition: "superseded",
            jobId: "wbf_stale_disposition_tool",
            reason: "replacement backfill covers the same dependency",
            supersededByJobId: "wbf_replacement_disposition_tool",
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "prepareWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(supersedePreview.status).toBe(200);
    const supersedePreviewBody = (await supersedePreview.json()) as {
      output: {
        request: {
          disposition: string;
          supersededByJobId: string;
        };
        successorInvocation: {
          input: Record<string, unknown>;
          toolId: string;
        };
      };
    };
    expect(supersedePreviewBody.output.request).toMatchObject({
      disposition: "superseded",
      supersededByJobId: "wbf_replacement_disposition_tool"
    });

    const supersedeExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: supersedePreviewBody.output.successorInvocation.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: supersedePreviewBody.output.successorInvocation.toolId,
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(supersedeExecute.status).toBe(200);
    expect((await supersedeExecute.json()) as {
      output: {
        jobId: string;
        kind: string;
        operatorReason: string;
        status: string;
        supersededByJobId: string | null;
      };
    }).toMatchObject({
      output: {
        jobId: "wbf_stale_disposition_tool",
        kind: "workflow-backfill-disposition",
        operatorReason: "replacement backfill covers the same dependency",
        status: "superseded",
        supersededByJobId: "wbf_replacement_disposition_tool"
      }
    });

    const duplicateAbandonExecute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: abandonPreviewBody.output.successorInvocation.input,
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "requestWorkflowBackfillDisposition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(duplicateAbandonExecute.status).toBe(409);
    expect((await duplicateAbandonExecute.json()) as {
      output: {
        kind: string;
        reason: string;
        status: string;
      };
    }).toMatchObject({
      output: {
        kind: "workflow-backfill-disposition",
        reason: "backfill_job_terminal",
        status: "rejected"
      }
    });

    const dependenciesAfter = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workflowId: "wf_backfill_disposition_tool"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 26,
          principalId: "ops_backfill_tool",
          toolId: "readWorkflowDependencies",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(dependenciesAfter.status).toBe(200);
    const dependenciesAfterBody = (await dependenciesAfter.json()) as {
      output: {
        dependencies: {
          summary: {
            abandonedBackfillJobCount: number;
            attentionRequiredBackfillJobs: unknown[];
            failedBackfillJobCount: number;
            intentionallyClosedBackfillJobs: Array<{
              operatorAction: string;
              operatorActorPrincipalId: string;
              operatorReason: string;
              status: string;
              supersededByJobId: string | null;
            }>;
            staleRunningBackfillJobCount: number;
            supersededBackfillJobCount: number;
          };
          suggestedMaintenanceRequests: unknown[];
        };
      };
    };
    expect(dependenciesAfterBody.output.dependencies.summary).toMatchObject({
      abandonedBackfillJobCount: 1,
      attentionRequiredBackfillJobs: [],
      failedBackfillJobCount: 0,
      intentionallyClosedBackfillJobs: expect.arrayContaining([
        expect.objectContaining({
          operatorAction: "abandoned_backfill",
          operatorActorPrincipalId: "ops_backfill_tool",
          operatorReason: "workflow definition replaced before retry",
          status: "abandoned",
          supersededByJobId: null
        }),
        expect.objectContaining({
          operatorAction: "superseded_backfill",
          operatorActorPrincipalId: "ops_backfill_tool",
          operatorReason: "replacement backfill covers the same dependency",
          status: "superseded",
          supersededByJobId: "wbf_replacement_disposition_tool"
        })
      ]),
      staleRunningBackfillJobCount: 0,
      supersededBackfillJobCount: 1
    });
    expect(dependenciesAfterBody.output.dependencies.suggestedMaintenanceRequests).toEqual([]);
  });

  it("rejects malformed workflow maintenance alias arrays on agent-tool ingress", async () => {
    const { db, env } = createEnv();

    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        principal: {
          permissionScopeHash: "scope:wf:maintenance-alias-tool",
          permissionsVersion: 41,
          principalId: "wf_maintenance_alias_tool_service",
          schemaEpoch: 0
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_maintenance_alias_tool"
      },
      name: "Maintenance Alias Tool",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_maintenance_alias_tool",
      workflowKey: "maintenance-alias-tool"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_maintenance_alias_tool",
      workspaceId: "ws_1",
      principalId: "ops_maintenance_alias_tool",
      policyRevision: 41,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const cases: Array<{
      aliasKey: "aggregateAliases" | "lookupAliases" | "syncAliases";
      aliases: unknown;
      endpoint: "preview" | "execute";
      message: string;
      toolId: string;
    }> = [
      {
        aliasKey: "aggregateAliases",
        aliases: "total",
        endpoint: "preview",
        message: "aggregateAliases must be an array for this agent tool.",
        toolId: "prepareWorkflowAggregateMaintenance"
      },
      {
        aliasKey: "aggregateAliases",
        aliases: ["total", ""],
        endpoint: "execute",
        message: "aggregateAliases[1] is required for this agent tool.",
        toolId: "requestWorkflowAggregateMaintenance"
      },
      {
        aliasKey: "lookupAliases",
        aliases: "lookup_account_name",
        endpoint: "preview",
        message: "lookupAliases must be an array for this agent tool.",
        toolId: "prepareWorkflowLookupMaintenance"
      },
      {
        aliasKey: "lookupAliases",
        aliases: ["lookup_account_name", 42],
        endpoint: "execute",
        message: "lookupAliases[1] is required for this agent tool.",
        toolId: "requestWorkflowLookupMaintenance"
      },
      {
        aliasKey: "syncAliases",
        aliases: "sync_status",
        endpoint: "preview",
        message: "syncAliases must be an array for this agent tool.",
        toolId: "prepareWorkflowSyncMaintenance"
      },
      {
        aliasKey: "syncAliases",
        aliases: ["sync_status", null],
        endpoint: "execute",
        message: "syncAliases[1] is required for this agent tool.",
        toolId: "requestWorkflowSyncMaintenance"
      }
    ];

    for (const testCase of cases) {
      const response = await handleFetch(
        new Request(`https://example.test/v1/agent-tools/${testCase.endpoint}`, {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            input: {
              [testCase.aliasKey]: testCase.aliases,
              kind: "recompute",
              workflowId: "wf_maintenance_alias_tool"
            },
            permissionScopeHash: "scope:table:tbl_1",
            policyRevision: 41,
            principalId: "ops_maintenance_alias_tool",
            toolId: testCase.toolId,
            workspaceId: "ws_1"
          })
        }),
        env,
        {} as ExecutionContext
      );

      expect(response.status).toBe(400);
      expect((await response.json()) as { message: string }).toMatchObject({
        message: testCase.message
      });
    }
  });

  it("returns rejected command results for invalid field references on set-cell routes", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_base_1",
            idempotencyKey: "idem_base_1",
            payload: {
              baseId: "base_2",
              name: "Customer Ops",
              slug: "customer-ops"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/bases/base_2/tables", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_table_1",
            idempotencyKey: "idem_table_1",
            payload: {
              name: "Customers",
              slug: "customers",
              tableId: "tbl_customers"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_1",
            idempotencyKey: "idem_record_1",
            payload: {
              recordId: "rec_customer_1"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers/records/rec_customer_1/cells/fld_missing",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_1",
              idempotencyKey: "idem_cell_1",
              payload: {
                value: "Acme"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(body.result.status).toBe("rejected");
    expect(body.result.diagnostics).toEqual(["field_not_found:fld_missing"]);
  });

  it("supports record.update and record.archive through the table record routes", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_base_update_1",
            idempotencyKey: "idem_base_update_1",
            payload: {
              baseId: "base_update_1",
              name: "Customer Ops",
              slug: "customer-ops-update"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/bases/base_update_1/tables", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_table_update_1",
            idempotencyKey: "idem_table_update_1",
            payload: {
              name: "Customers",
              slug: "customers-update",
              tableId: "tbl_customers_update"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers_update/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_update_1",
            idempotencyKey: "idem_field_update_1",
            payload: {
              fieldId: "fld_name_update",
              fieldKey: "name",
              fieldType: "text.single_line",
              label: "Name"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers_update/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_update_1",
            idempotencyKey: "idem_record_update_1",
            payload: {
              recordId: "rec_customer_update_1"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    const updateRecord = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers_update/records/rec_customer_update_1",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_record_update_2",
              idempotencyKey: "idem_record_update_2",
              payload: {
                patch: {
                  name: "Beta Corp"
                }
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(updateRecord.status).toBe(200);
    const updateBody = (await updateRecord.json()) as {
      aggregate: { id: string; type: string };
      result: { events: Array<{ eventType: string }> };
    };
    expect(updateBody.aggregate).toEqual({
      id: "rec_customer_update_1",
      type: "record"
    });
    expect(updateBody.result.events[0]?.eventType).toBe("record.updated");

    const readUpdatedRecord = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers_update/records/rec_customer_update_1?workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(readUpdatedRecord.status).toBe(200);
    const updatedBody = (await readUpdatedRecord.json()) as {
      projection: { fields: { name: string } };
      record: { record_revision: number };
    };
    expect(updatedBody.projection.fields.name).toBe("Beta Corp");
    expect(updatedBody.record.record_revision).toBe(1);

    const archiveRecord = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers_update/records/rec_customer_update_1",
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_record_archive_1",
              idempotencyKey: "idem_record_archive_1"
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(archiveRecord.status).toBe(200);
    const archiveBody = (await archiveRecord.json()) as {
      result: { events: Array<{ eventType: string }> };
    };
    expect(archiveBody.result.events[0]?.eventType).toBe("record.archived");

    const readArchivedRecord = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_customers_update/records/rec_customer_update_1?workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(readArchivedRecord.status).toBe(404);
  });

  it("preserves the canonical row owner invariant across update ingress routes", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        owner: ["principal_1"]
      },
      recordId: "rec_owner_route_guard",
      recordKey: "rec-owner-route-guard",
      tableId: "tbl_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner",
      fieldKey: "owner",
      fieldType: "principal.user",
      recordId: "rec_owner_route_guard",
      tableId: "tbl_1",
      value: ["principal_1"]
    });

    const updateRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_owner_route_guard", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_owner_route_guard",
            idempotencyKey: "idem_record_owner_route_guard",
            payload: {
              patch: {
                owner: []
              }
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(updateRecord.status).toBe(200);
    const updateBody = (await updateRecord.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(updateBody.result.status).toBe("rejected");
    expect(updateBody.result.diagnostics).toEqual(["row_owner_value_required:fld_owner"]);

    const bulkPatch = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records:bulkPatch", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_bulk_owner_route_guard",
            idempotencyKey: "idem_bulk_owner_route_guard",
            payload: {
              updates: [
                {
                  patch: {
                    owner: []
                  },
                  recordId: "rec_owner_route_guard"
                }
              ]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(bulkPatch.status).toBe(200);
    const bulkBody = (await bulkPatch.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(bulkBody.result.status).toBe("rejected");
    expect(bulkBody.result.diagnostics).toEqual(["row_owner_value_required:fld_owner"]);

    const setCell = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_owner_route_guard/cells/fld_owner",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_owner_route_guard",
              idempotencyKey: "idem_cell_owner_route_guard",
              payload: {
                value: []
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(setCell.status).toBe(200);
    const setCellBody = (await setCell.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(setCellBody.result.status).toBe("rejected");
    expect(setCellBody.result.diagnostics).toEqual(["row_owner_value_required:fld_owner"]);

    const ownerCell = db.inner
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_1", "rec_owner_route_guard", "fld_owner") as {
      value_json: string;
    };
    expect(JSON.parse(ownerCell.value_json)).toMatchObject({
      raw: ["principal_1"],
      valueType: "principal.user"
    });
  });

  it("allows canonical row owner reassignment through record.update ingress", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        owner: ["principal_1"]
      },
      recordId: "rec_owner_route_reassign",
      recordKey: "rec-owner-route-reassign",
      tableId: "tbl_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner",
      fieldKey: "owner",
      fieldType: "principal.user",
      recordId: "rec_owner_route_reassign",
      tableId: "tbl_1",
      value: ["principal_1"]
    });

    const updateRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_owner_route_reassign", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_owner_route_reassign",
            idempotencyKey: "idem_record_owner_route_reassign",
            payload: {
              patch: {
                owner: ["principal_2"]
              }
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(updateRecord.status).toBe(200);
    const updateBody = (await updateRecord.json()) as {
      result: { status: string };
    };
    expect(updateBody.result.status).toBe("accepted");

    const ownerCell = db.inner
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_1", "rec_owner_route_reassign", "fld_owner") as {
      value_json: string;
    };
    expect(JSON.parse(ownerCell.value_json)).toMatchObject({
      raw: ["principal_2"],
      valueType: "principal.user"
    });
  });

  it("supports records.bulk_patch through preview and execute ingress", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/apps", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_base_bulk_1",
            idempotencyKey: "idem_base_bulk_1",
            payload: {
              baseId: "base_bulk_1",
              name: "Customer Ops",
              slug: "customer-ops-bulk"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/bases/base_bulk_1/tables", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_table_bulk_1",
            idempotencyKey: "idem_table_bulk_1",
            payload: {
              name: "Customers",
              slug: "customers-bulk",
              tableId: "tbl_customers_bulk"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers_bulk/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_bulk_1",
            idempotencyKey: "idem_field_bulk_1",
            payload: {
              fieldId: "fld_name_bulk",
              fieldKey: "name",
              fieldType: "text.single_line",
              label: "Name"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    for (const recordId of ["rec_customer_bulk_1", "rec_customer_bulk_2"]) {
      await handleFetch(
        new Request("https://example.test/v1/tables/tbl_customers_bulk/records", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: `cmd_${recordId}`,
              idempotencyKey: `idem_${recordId}`,
              payload: {
                recordId
              }
            })
          )
        }),
        env,
        {} as ExecutionContext
      );
    }

    const preview = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_records_bulk_preview_1",
            commandType: "records.bulk_patch",
            idempotencyKey: "idem_records_bulk_preview_1",
            payload: {
              updates: [
                {
                  patch: {
                    name: "Alpha"
                  },
                  recordId: "rec_customer_bulk_1"
                },
                {
                  patch: {
                    name: "Beta"
                  },
                  recordId: "rec_customer_bulk_2"
                }
              ]
            },
            scope: "table",
            tableId: "tbl_customers_bulk"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      aggregate: { id: string; type: string };
      result: { diagnostics: string[]; status: string };
    };
    expect(previewBody.aggregate).toEqual({
      id: "tbl_customers_bulk",
      type: "table"
    });
    expect(previewBody.result.status).toBe("accepted");
    expect(previewBody.result.diagnostics).toEqual(["dry_run"]);

    const execute = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_customers_bulk/records:bulkPatch", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_records_bulk_execute_1",
            idempotencyKey: "idem_records_bulk_execute_1",
            payload: {
              updates: [
                {
                  patch: {
                    name: "Alpha"
                  },
                  recordId: "rec_customer_bulk_1"
                },
                {
                  patch: {
                    name: "Beta"
                  },
                  recordId: "rec_customer_bulk_2"
                }
              ]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(execute.status).toBe(200);
    const executeBody = (await execute.json()) as {
      aggregate: { id: string; type: string };
      result: { events: Array<{ eventType: string }> };
    };
    expect(executeBody.aggregate).toEqual({
      id: "tbl_customers_bulk",
      type: "table"
    });
    expect(executeBody.result.events[0]?.eventType).toBe("records.bulk_patched");

    for (const [recordId, expectedName] of [
      ["rec_customer_bulk_1", "Alpha"],
      ["rec_customer_bulk_2", "Beta"]
    ] as const) {
      const recordResponse = await handleFetch(
        new Request(
          `https://example.test/v1/tables/tbl_customers_bulk/records/${recordId}?workspaceId=ws_1`
        ),
        env,
        {} as ExecutionContext
      );
      expect(recordResponse.status).toBe(200);
      const body = (await recordResponse.json()) as {
        projection: { fields: { name: string } };
        record: { record_revision: number };
      };
      expect(body.projection.fields.name).toBe(expectedName);
      expect(body.record.record_revision).toBe(1);
    }
  });

  it("rejects invalid records.bulk_patch payloads through command preview ingress", async () => {
    const { env } = createEnv();

    const preview = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_records_bulk_invalid_1",
            commandType: "records.bulk_patch",
            idempotencyKey: "idem_records_bulk_invalid_1",
            payload: {
              updates: []
            },
            scope: "table",
            tableId: "tbl_1"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(preview.status).toBe(200);
    const body = (await preview.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(body.result.status).toBe("rejected");
    expect(body.result.diagnostics).toEqual(["payload_updates_must_be_non_empty_array"]);
  });

  it("serves direct record reads from canonical record plus projection state", async () => {
    const { db, env } = createEnv();
    db.inner
      .prepare(
        `INSERT INTO records (
          id,
          workspace_id,
          table_id,
          record_key,
          record_revision,
          created_at,
          updated_at,
          archived_at,
          last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "rec_1",
        "ws_1",
        "tbl_1",
        "record-1",
        2,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:01:00.000Z",
        null,
        "evt_1"
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
        "rec_1",
        JSON.stringify({
          fields: {
            name: "Acme"
          }
        }),
        "",
        3,
        "evt_1",
        "2026-06-06T00:01:00.000Z"
      );

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1?workspaceId=ws_1"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projection: { fields: { name: string } };
      projectionVersion: number;
      record: { id: string; record_revision: number; lastEventId: string };
    };

    expect(body.projection.fields.name).toBe("Acme");
    expect(body.projectionVersion).toBe(3);
    expect(body.record.id).toBe("rec_1");
  expect(body.record.record_revision).toBe(2);
  expect(body.record.lastEventId).toBe("evt_1");
  });

  it("serves table activity reads in descending table-sequence order with a deterministic cursor", async () => {
    const { db, env } = createEnv();

    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      aggregateId: "view_pipeline",
      aggregateType: "view",
      commandId: "cmd_view_1",
      commandType: "view.update",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "view.updated",
      tableId: "tbl_1",
      tableSequence: 3,
      workspaceSequence: 3
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_secret",
        recordId: "rec_1",
        value: "hidden"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/activity?workspaceId=ws_1&limit=2"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{
        command: { commandType: string | null };
        eventId: string;
        record: { id: string; key: string | null } | null;
        sequence: { table: number | null };
        target: { id: string | null; type: string } | null;
      }>;
      page: {
        limit: number;
        nextBeforeTableSequence: number | null;
      };
      tableId: string;
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.tableId).toBe("tbl_1");
    expect(body.page).toEqual({
      limit: 2,
      nextBeforeTableSequence: 2
    });
    expect(body.entries).toEqual([
      {
        command: {
          commandId: "cmd_view_1",
          commandType: "view.update"
        },
        createdAt: "2026-06-06T00:03:00.000Z",
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        eventId: "evt_3",
        eventType: "view.updated",
        record: null,
        sequence: {
          table: 3,
          workspace: 3
        },
        target: {
          id: "view_pipeline",
          type: "view"
        }
      },
      {
        command: {
          commandId: "cmd_cell_1",
          commandType: "cell.set"
        },
        createdAt: "2026-06-06T00:02:00.000Z",
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        eventId: "evt_2",
        eventType: "cell.set",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 2,
          workspace: 2
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("serves workspace activity reads in descending workspace-sequence order with a deterministic cursor", async () => {
    const { db, env } = createEnv();

    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      aggregateId: "view_pipeline",
      aggregateType: "view",
      commandId: "cmd_view_1",
      commandType: "view.update",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "view.updated",
      tableId: "tbl_1",
      tableSequence: 3,
      workspaceSequence: 3
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_secret",
        recordId: "rec_1",
        value: "hidden"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      aggregateId: "app_1",
      aggregateType: "base",
      commandId: "cmd_base_1",
      commandType: "base.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "base.created",
      payload: {
        baseId: "app_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/activity?limit=2"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{
        command: { commandType: string | null };
        eventId: string;
        record: { id: string; key: string | null } | null;
        sequence: { workspace: number };
        target: { id: string | null; type: string } | null;
      }>;
      page: {
        limit: number;
        nextBeforeWorkspaceSequence: number | null;
      };
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.page).toEqual({
      limit: 2,
      nextBeforeWorkspaceSequence: 2
    });
    expect(body.entries).toEqual([
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_view_1",
          commandType: "view.update"
        },
        createdAt: "2026-06-06T00:03:00.000Z",
        eventId: "evt_3",
        eventType: "view.updated",
        record: null,
        sequence: {
          table: 3,
          workspace: 3
        },
        target: {
          id: "view_pipeline",
          type: "view"
        }
      },
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_cell_1",
          commandType: "cell.set"
        },
        createdAt: "2026-06-06T00:02:00.000Z",
        eventId: "evt_2",
        eventType: "cell.set",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 2,
          workspace: 2
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("serves table activity reads in descending table-sequence order with a deterministic cursor", async () => {
    const { db, env } = createEnv();

    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      aggregateId: "wf_pipeline",
      aggregateType: "workflow",
      commandId: "cmd_workflow_1",
      commandType: "workflow.publish",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "workflow.published",
      tableId: "tbl_1",
      tableSequence: 3,
      workspaceSequence: 3,
      actor: {
        mode: "workflow",
        principalId: "wf_pipeline"
      }
    });
    insertEventLedgerEntry(db, {
      actor: {
        mode: "agent",
        principalId: "agt_sync"
      },
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_secret",
        recordId: "rec_1",
        value: "hidden"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      aggregateId: "fld_secret",
      aggregateType: "field",
      commandId: "cmd_field_1",
      commandType: "field.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "field.created",
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/activity?workspaceId=ws_1&limit=2"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{
        actor: { mode: string | null; principalId: string | null };
        eventId: string;
        record: { id: string; key: string | null } | null;
        target: { id: string | null; type: string } | null;
      }>;
      page: {
        limit: number;
        nextBeforeTableSequence: number | null;
      };
      tableId: string;
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.tableId).toBe("tbl_1");
    expect(body.page).toEqual({
      limit: 2,
      nextBeforeTableSequence: 2
    });
    expect(body.entries).toEqual([
      {
        actor: {
          mode: "workflow",
          principalId: "wf_pipeline"
        },
        command: {
          commandId: "cmd_workflow_1",
          commandType: "workflow.publish"
        },
        createdAt: "2026-06-06T00:03:00.000Z",
        eventId: "evt_3",
        eventType: "workflow.published",
        record: null,
        sequence: {
          table: 3,
          workspace: 3
        },
        target: {
          id: "wf_pipeline",
          type: "workflow"
        }
      },
      {
        actor: {
          mode: "agent",
          principalId: "agt_sync"
        },
        command: {
          commandId: "cmd_cell_1",
          commandType: "cell.set"
        },
        createdAt: "2026-06-06T00:02:00.000Z",
        eventId: "evt_2",
        eventType: "cell.set",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 2,
          workspace: 2
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("serves record activity reads in descending table-sequence order with a deterministic cursor", async () => {
    const { db, env } = createEnv();

    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      actor: {
        mode: "agent",
        principalId: "agt_sync"
      },
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_secret",
        recordId: "rec_1",
        value: "priority"
      },
      tableId: "tbl_1",
      tableSequence: 3,
      workspaceSequence: 3
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_field_1",
      commandType: "field.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "field.created",
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1/activity?workspaceId=ws_1&limit=1"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{
        actor: { mode: string | null; principalId: string | null };
        eventId: string;
        record: { id: string; key: string | null } | null;
      }>;
      page: {
        limit: number;
        nextBeforeTableSequence: number | null;
      };
      record: {
        id: string;
        record_key: string;
      };
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.record.id).toBe("rec_1");
    expect(body.record.record_key).toBe("record-1");
    expect(body.page).toEqual({
      limit: 1,
      nextBeforeTableSequence: 3
    });
    expect(body.entries).toEqual([
      {
        actor: {
          mode: "agent",
          principalId: "agt_sync"
        },
        command: {
          commandId: "cmd_cell_1",
          commandType: "cell.set"
        },
        createdAt: "2026-06-06T00:03:00.000Z",
        eventId: "evt_3",
        eventType: "cell.set",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 3,
          workspace: 3
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("serves direct app bootstrap metadata through workspace-scope permission coordinates", async () => {
    const { db, env } = createEnv();
    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.publish"],
      fields: {},
      policyRevision: 45,
      principalId: "usr_app_reader",
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      snapshotId: "snap_app_detail_workspace",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/apps/app_1?workspaceId=ws_1&principalId=usr_app_reader&permissionScopeHash=scope:workspace&policyRevision=45"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appId: string;
      createdAt: string;
      name: string;
      slug: string;
      tableCount: number;
      tableIds: string[];
      updatedAt: string;
      workspaceId: string;
    };

    expect(body).toEqual({
      appId: "app_1",
      createdAt: "2026-06-06T00:00:00.000Z",
      name: "App 1",
      slug: "app-1",
      tableCount: 1,
      tableIds: ["tbl_1"],
      updatedAt: "2026-06-06T00:00:00.000Z",
      workspaceId: "ws_1"
    });
  });

  it("serves permission-scoped app activity using workspace-scope snapshot coordinates", async () => {
    const { db, env } = createEnv();
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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_app_activity_workspace",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 42,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      fields: {}
    });
    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_other_app",
      commandType: "record.create",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "record.created",
      payload: {
        recordId: "rec_2"
      },
      tableId: "tbl_2",
      tableSequence: 1,
      workspaceSequence: 3
    });
    insertEventLedgerEntry(db, {
      aggregateId: "wf_pipeline",
      aggregateType: "workflow",
      commandId: "cmd_workflow_1",
      commandType: "workflow.publish",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "workflow.published",
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/apps/app_1/activity?workspaceId=ws_1&principalId=usr_member&permissionScopeHash=scope:workspace&policyRevision=42"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appId: string;
      entries: Array<{
        eventId: string;
        target: { id: string | null; type: string } | null;
      }>;
      page: {
        limit: number;
        nextBeforeWorkspaceSequence: number | null;
      };
      workspaceId: string;
    };

    expect(body.appId).toBe("app_1");
    expect(body.workspaceId).toBe("ws_1");
    expect(body.page).toEqual({
      limit: 25,
      nextBeforeWorkspaceSequence: null
    });
    expect(body.entries).toEqual([
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_workflow_1",
          commandType: "workflow.publish"
        },
        createdAt: "2026-06-06T00:02:00.000Z",
        eventId: "evt_2",
        eventType: "workflow.published",
        record: null,
        sequence: {
          table: 2,
          workspace: 2
        },
        target: {
          id: "wf_pipeline",
          type: "workflow"
        }
      },
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_record_1",
          commandType: "record.create"
        },
        createdAt: "2026-06-06T00:01:00.000Z",
        eventId: "evt_1",
        eventType: "record.created",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 1,
          workspace: 1
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("serves permission-scoped direct record reads with visible, redacted, and hidden fields", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
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
    setFieldPrincipalPermission(db, {
      fieldId: "fld_name",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_salary",
      permission: {
        agent: false,
        read: "hidden",
        workflow: false,
        write: false
      },
      principalId: "usr_member"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_customer_note",
      permission: {
        agent: true,
        read: "redacted",
        workflow: true,
        write: false
      },
      principalId: "usr_member"
    });
    db.inner
      .prepare(
        `INSERT INTO records (
          id,
          workspace_id,
          table_id,
          record_key,
          record_revision,
          created_at,
          updated_at,
          archived_at,
          last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "rec_1",
        "ws_1",
        "tbl_1",
        "record-1",
        4,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:04:00.000Z",
        null,
        "evt_4"
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
        "rec_1",
        JSON.stringify({
          fields: {
            customer_note: "VIP renewal risk",
            name: "Acme",
            salary: "120000"
          }
        }),
        "",
        5,
        "evt_4",
        "2026-06-06T00:04:00.000Z"
      );

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1?workspaceId=ws_1&principalId=usr_member"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projection: { fields: Record<string, unknown> };
      projectionVersion: number;
      record: { id: string; lastEventId: string; record_revision: number };
      surface: {
        diagnostics: string[];
        hiddenFieldIds: string[];
        redactedFieldIds: string[];
        redactionApplied: boolean;
        states: Record<string, string>;
      };
    };

    expect(body.projection).toEqual({
      fields: {
        customer_note: "[redacted]",
        name: "Acme"
      }
    });
    expect(body.surface).toMatchObject({
      hiddenFieldIds: ["fld_salary"],
      redactedFieldIds: ["fld_customer_note"],
      redactionApplied: true,
      states: {
        fld_customer_note: "redacted",
        fld_name: "visible",
        fld_salary: "hidden"
      }
    });
    expect(body.surface.diagnostics).toEqual([
      "field_redacted:fld_customer_note",
      "field_read_only:fld_customer_note",
      "field_hidden:fld_salary",
      "field_read_only:fld_salary"
    ]);
  expect(body.projectionVersion).toBe(5);
  expect(body.record.id).toBe("rec_1");
  expect(body.record.record_revision).toBe(4);
  expect(body.record.lastEventId).toBe("evt_4");
  });

  it("serves permission-scoped record activity without exposing raw field identifiers", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_record_activity_member",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 39,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_title: {
          agent: true,
          fieldId: "fld_title",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertRecordProjection(db, {
      fields: {
        title: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_title",
        recordId: "rec_1",
        value: "Acme"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1/activity?workspaceId=ws_1&principalId=usr_member&permissionScopeHash=scope:table:tbl_1&policyRevision=39"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<{
        eventId: string;
        target: { id: string | null; type: string } | null;
      }>;
      page: {
        limit: number;
        nextBeforeTableSequence: number | null;
      };
      record: {
        id: string;
        lastEventId: string | null;
      };
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.record).toMatchObject({
      id: "rec_1",
      lastEventId: "evt_rec_1"
    });
    expect(body.page).toEqual({
      limit: 25,
      nextBeforeTableSequence: null
    });
    expect(body.entries).toEqual([
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_cell_1",
          commandType: "cell.set"
        },
        createdAt: "2026-06-06T00:02:00.000Z",
        eventId: "evt_2",
        eventType: "cell.set",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 2,
          workspace: 2
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      },
      {
        actor: {
          mode: "user",
          principalId: "principal_1"
        },
        command: {
          commandId: "cmd_record_1",
          commandType: "record.create"
        },
        createdAt: "2026-06-06T00:01:00.000Z",
        eventId: "evt_1",
        eventType: "record.created",
        record: {
          id: "rec_1",
          key: "record-1"
        },
        sequence: {
          table: 1,
          workspace: 1
        },
        target: {
          id: "rec_1",
          type: "record"
        }
      }
    ]);
  });

  it("routes permission-scoped workspace activity through the readWorkspaceActivityHistory agent tool", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workspace_activity_agent",
      workspaceId: "ws_1",
      principalId: "agt_workspace_history",
      policyRevision: 43,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      fields: {}
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_workflow_1",
      commandType: "workflow.publish",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "workflow.published",
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/activity?principalId=agt_workspace_history&permissionScopeHash=scope:workspace&policyRevision=43"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {},
          permissionScopeHash: "scope:workspace",
          policyRevision: 43,
          principalId: "agt_workspace_history",
          toolId: "readWorkspaceActivityHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        activity: Record<string, unknown>;
        kind: string;
      };
    };

    expect(agentBody.output).toEqual({
      activity: directBody,
      kind: "activity-history"
    });
  });

  it("routes permission-scoped app activity through the readAppActivityHistory agent tool", async () => {
    const { db, env } = createEnv();
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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_app_activity_agent",
      workspaceId: "ws_1",
      principalId: "agt_app_history",
      policyRevision: 44,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      fields: {}
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_other_app",
      commandType: "record.create",
      createdAt: "2026-06-06T00:03:00.000Z",
      eventId: "evt_3",
      eventType: "record.created",
      payload: {
        recordId: "rec_2"
      },
      tableId: "tbl_2",
      tableSequence: 1,
      workspaceSequence: 3
    });
    insertEventLedgerEntry(db, {
      aggregateId: "wf_pipeline",
      aggregateType: "workflow",
      commandId: "cmd_workflow_1",
      commandType: "workflow.publish",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "workflow.published",
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_record_1",
      commandType: "record.create",
      createdAt: "2026-06-06T00:01:00.000Z",
      eventId: "evt_1",
      eventType: "record.created",
      payload: {
        recordId: "rec_1"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/apps/app_1/activity?workspaceId=ws_1&principalId=agt_app_history&permissionScopeHash=scope:workspace&policyRevision=44"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            appId: "app_1"
          },
          permissionScopeHash: "scope:workspace",
          policyRevision: 44,
          principalId: "agt_app_history",
          toolId: "readAppActivityHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        activity: Record<string, unknown>;
        kind: string;
      };
    };

    expect(agentBody.output).toEqual({
      activity: directBody,
      kind: "activity-history"
    });
  });

  it("rejects malformed workspace activity permission coordinates consistently across direct and agent ingress", async () => {
    const { env } = createEnv();

    const directResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/activity?principalId=agt_workspace_history&policyRevision=oops"),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {},
          policyRevision: "oops",
          principalId: "agt_workspace_history",
          toolId: "readWorkspaceActivityHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(400);
    expect((await directResponse.json()) as { message: string }).toMatchObject({
      message:
        "policyRevision must be a finite number when provided for permissioned workspace activity reads."
    });
    expect(agentResponse.status).toBe(400);
    expect((await agentResponse.json()) as { message: string }).toMatchObject({
      message: "policyRevision must be a finite number when provided for agent tool preview."
    });
  });

  it("routes permission-scoped record activity through the readActivityHistory agent tool", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_record_activity_agent",
      workspaceId: "ws_1",
      principalId: "agt_history",
      policyRevision: 39,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_title: {
          agent: true,
          fieldId: "fld_title",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertRecordProjection(db, {
      fields: {
        title: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertEventLedgerEntry(db, {
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      createdAt: "2026-06-06T00:02:00.000Z",
      eventId: "evt_2",
      eventType: "cell.set",
      payload: {
        fieldId: "fld_title",
        recordId: "rec_1",
        value: "Acme"
      },
      tableId: "tbl_1",
      tableSequence: 2,
      workspaceSequence: 2
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1/activity?workspaceId=ws_1&principalId=agt_history&permissionScopeHash=scope:table:tbl_1&policyRevision=39"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            recordId: "rec_1",
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 39,
          principalId: "agt_history",
          toolId: "readActivityHistory",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        activity: Record<string, unknown>;
        kind: string;
      };
    };

    expect(agentBody.output).toEqual({
      activity: directBody,
      kind: "activity-history"
    });
  });

  it("rejects stale direct record read snapshot coordinates after resolving the effective table scope", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_direct_record_member",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 6,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1?workspaceId=ws_1&principalId=usr_member&policyRevision=5&permissionScopeHash=scope:record:rec_1"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Requested permissionScopeHash scope:record:rec_1 does not match resolved scope scope:table:tbl_1."
    );
  });

  it("routes permission-scoped direct record reads through the inspectRecord agent tool", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
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
      fieldId: "fld_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_record_member",
      workspaceId: "ws_1",
      principalId: "agt_record_reader",
      policyRevision: 17,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_customer_note: {
          agent: false,
          fieldId: "fld_customer_note",
          fieldType: "text.long",
          read: "redacted",
          workflow: false,
          write: false
        },
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_salary: {
          agent: false,
          fieldId: "fld_salary",
          fieldType: "number.decimal",
          read: "hidden",
          workflow: false,
          write: false
        }
      }
    });
    insertRecordProjection(db, {
      fields: {
        customer_note: "VIP renewal risk",
        name: "Acme",
        salary: "120000"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_1?workspaceId=ws_1&principalId=agt_record_reader&permissionScopeHash=scope:table:tbl_1&policyRevision=17"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            recordId: "rec_1",
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 17,
          principalId: "agt_record_reader",
          toolId: "inspectRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        record: Record<string, unknown>;
      };
    };

    expect(agentBody.output).toEqual({
      kind: "record-inspection",
      record: directBody
    });
  });

  it("builds permission-sanitized agent tool previews through the worker ingress", async () => {
    const { db, env } = createEnv();

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
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_customer_note",
      permission: {
        agent: false,
        read: "hidden",
        workflow: false,
        write: false
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            commandId: "cmd_view_preview",
            filterFieldIds: ["fld_customer_note"],
            idempotencyKey: "idem_view_preview",
            schemaEpoch: 1,
            sortFieldIds: ["fld_status"],
            tableId: "tbl_1",
            viewId: "view_public",
            viewName: "Public Pipeline",
            visibleFieldIds: ["fld_title", "fld_customer_note", "fld_status"]
          },
          principalId: "agt_assist",
          toolId: "createView",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      input: {
        filterFieldIds: string[];
        sortFieldIds?: string[];
        visibleFieldIds: string[];
      };
      inputDiagnostics: string[];
      output: {
        command: {
          actor: { mode: string; principalId: string };
          payload: {
            filterFieldIds: string[];
            sortFieldIds: string[];
            visibleFieldIds: string[];
          };
          workspaceId: string;
        };
        diffs: Array<{
          after: {
            filterFieldIds: string[];
            sortFieldIds: string[];
            visibleFieldIds: string[];
          };
        }>;
        kind: string;
      };
      outputDiagnostics: string[];
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(body.tool).toEqual({
      id: "createView",
      phase: "preview",
      scope: "view",
      successorToolId: "dryRunCommand"
    });
    expect(body.inputDiagnostics).toEqual(["agent_hidden:fld_customer_note"]);
    expect(body.input).toMatchObject({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.output.kind).toBe("command-draft");
    expect(body.output.command.actor).toEqual({
      mode: "agent",
      principalId: "agt_assist"
    });
    expect(body.output.command.workspaceId).toBe("ws_1");
    expect(body.output.command.payload).toMatchObject({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.output.diffs[0]?.after).toMatchObject({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.outputDiagnostics).toEqual([]);
  });

  it("builds a saved-view deletion draft through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            commandId: "cmd_view_delete_preview",
            idempotencyKey: "idem_view_delete_preview",
            tableId: "tbl_1",
            viewId: "view_public"
          },
          principalId: "agt_assist",
          toolId: "deleteView",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: {
        command: {
          actor: { mode: string; principalId: string };
          commandType: string;
          payload: {
            tableId: string;
            viewId: string;
          };
          scope: string;
          tableId: string;
          workspaceId: string;
        };
        diffs: Array<{
          action: string;
          path: string;
        }>;
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(body.tool).toEqual({
      id: "deleteView",
      phase: "preview",
      scope: "view",
      successorToolId: "dryRunCommand"
    });
    expect(body.output.kind).toBe("command-draft");
    expect(body.output.command).toMatchObject({
      actor: {
        mode: "agent",
        principalId: "agt_assist"
      },
      commandType: "view.delete",
      payload: {
        tableId: "tbl_1",
        viewId: "view_public"
      },
      scope: "workspace",
      tableId: "tbl_1",
      workspaceId: "ws_1"
    });
    expect(body.output.diffs).toEqual([
      {
        action: "delete",
        after: {
          tableId: "tbl_1",
          viewId: "view_public"
        },
        path: "/tables/tbl_1/views/view_public"
      }
    ]);
  });

  it("builds record mutation drafts through the agent-tool preview ingress with writable-field sanitization", async () => {
    const { db, env } = createEnv();

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
    setFieldPrincipalPermission(db, {
      fieldId: "fld_customer_note",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: false
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });

    const createRecordResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            cells: {
              fld_customer_note: "internal only",
              fld_status: "open",
              fld_title: "Acme"
            },
            commandId: "cmd_record_preview",
            idempotencyKey: "idem_record_preview",
            recordId: "rec_001",
            schemaEpoch: 1,
            tableId: "tbl_1"
          },
          principalId: "agt_assist",
          toolId: "createRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(createRecordResponse.status).toBe(200);
    const createRecordBody = (await createRecordResponse.json()) as {
      input: {
        cells: Record<string, unknown>;
      };
      inputDiagnostics: string[];
      output: {
        command: {
          payload: {
            cells: Record<string, unknown>;
            recordId: string;
          };
        };
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(createRecordBody.tool).toEqual({
      id: "createRecord",
      phase: "preview",
      scope: "table",
      successorToolId: "dryRunCommand"
    });
    expect(createRecordBody.inputDiagnostics).toEqual(["agent_non_writable:fld_customer_note"]);
    expect(createRecordBody.input).toMatchObject({
      cells: {
        fld_status: "open",
        fld_title: "Acme"
      },
      recordId: "rec_001",
      tableId: "tbl_1"
    });
    expect(createRecordBody.output.kind).toBe("command-draft");
    expect(createRecordBody.output.command.payload).toEqual({
      cells: {
        fld_status: "open",
        fld_title: "Acme"
      },
      recordId: "rec_001"
    });

    const updateRecordResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            patch: {
              fld_customer_note: "internal only",
              fld_status: "qualified",
              fld_title: "Acme Revised"
            },
            recordId: "rec_001",
            tableId: "tbl_1"
          },
          principalId: "agt_assist",
          toolId: "updateRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(updateRecordResponse.status).toBe(200);
    const updateRecordBody = (await updateRecordResponse.json()) as {
      input: {
        patch: Record<string, unknown>;
      };
      inputDiagnostics: string[];
      output: {
        command: {
          payload: {
            patch: Record<string, unknown>;
            recordId: string;
          };
        };
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(updateRecordBody.tool).toEqual({
      id: "updateRecord",
      phase: "preview",
      scope: "table",
      successorToolId: "dryRunCommand"
    });
    expect(updateRecordBody.inputDiagnostics).toEqual(["agent_non_writable:fld_customer_note"]);
    expect(updateRecordBody.input).toMatchObject({
      patch: {
        fld_status: "qualified",
        fld_title: "Acme Revised"
      },
      recordId: "rec_001",
      tableId: "tbl_1"
    });
    expect(updateRecordBody.output.kind).toBe("command-draft");
    expect(updateRecordBody.output.command.payload).toEqual({
      patch: {
        fld_status: "qualified",
        fld_title: "Acme Revised"
      },
      recordId: "rec_001"
    });

    const archiveRecordResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            recordId: "rec_001",
            tableId: "tbl_1"
          },
          principalId: "agt_assist",
          toolId: "archiveRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(archiveRecordResponse.status).toBe(200);
    const archiveRecordBody = (await archiveRecordResponse.json()) as {
      output: {
        command: {
          payload: {
            recordId: string;
          };
        };
        kind: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(archiveRecordBody.tool).toEqual({
      id: "archiveRecord",
      phase: "preview",
      scope: "table",
      successorToolId: "dryRunCommand"
    });
    expect(archiveRecordBody.output.kind).toBe("command-draft");
    expect(archiveRecordBody.output.command.payload).toEqual({
      recordId: "rec_001"
    });

    const missingPatchResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            recordId: "rec_001",
            tableId: "tbl_1"
          },
          principalId: "agt_assist",
          toolId: "updateRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(missingPatchResponse.status).toBe(400);
    await expect(missingPatchResponse.text()).resolves.toContain("patch is required for this agent tool.");

    const updateCellResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            fieldId: "fld_customer_note",
            recordId: "rec_001",
            tableId: "tbl_1",
            value: "internal only"
          },
          principalId: "agt_assist",
          toolId: "updateCell",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(updateCellResponse.status).toBe(400);
    await expect(updateCellResponse.text()).resolves.toContain("value is required for this agent tool.");
  });

  it("applies view-scoped grouped create defaults through the agent tool preview ingress", async () => {
    const { db, env } = createEnv();

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
    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "active"
        }
      ],
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_preview_create",
      viewKey: "preview-create",
      viewName: "Preview Create",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
      fields: {
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
      policyRevision: 16,
      principalId: "agt_view_creator",
      schemaEpoch: 1,
      scopeHash: "scope:view:view_preview_create",
      snapshotId: "snap_view_preview_create",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            cells: {
              fld_title: "Agent Draft"
            },
            commandId: "cmd_view_preview_create",
            idempotencyKey: "idem_view_preview_create",
            recordId: "rec_view_preview",
            tableId: "tbl_1",
            targetGroupValue: "active",
            viewId: "view_preview_create"
          },
          permissionScopeHash: "scope:view:view_preview_create",
          policyRevision: 16,
          principalId: "agt_view_creator",
          toolId: "createRecord",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as {
      input: { cells: Record<string, unknown> };
      output: { command: { payload: { cells: Record<string, unknown> } } };
      permissionScope: { scopeHash: string };
    }).toMatchObject({
      input: {
        cells: {
          fld_status: "active",
          fld_title: "Agent Draft"
        }
      },
      output: {
        command: {
          payload: {
            cells: {
              fld_status: "active",
              fld_title: "Agent Draft"
            }
          }
        }
      },
      permissionScope: {
        scopeHash: "scope:view:view_preview_create"
      }
    });
  });

  it("explains permission outcomes through the agent tool preview ingress with view-scoped snapshots", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        owner: ["usr_owner"],
        secret_note: "hidden note",
        title: "Acme"
      },
      recordId: "rec_permission_owner_context",
      recordKey: "permission-owner-context",
      tableId: "tbl_1"
    });
    insertView(db, {
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            fieldId: "fld_secret_note",
            recordId: "rec_permission_owner_context",
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access: {
        allowed: boolean;
        toolId: string;
      };
      output: {
        explanation: {
          evaluationContext?: {
            rowOwner?: {
              alias: string;
              fieldId: string;
              fieldKey: string;
              fieldType: string;
              matchesPrincipal: boolean;
              principalIds: string[];
              recordId: string;
            };
          };
          fieldId: string;
          fieldType: string;
          scope: {
            recordId: string | null;
            tableId: string | null;
            viewId: string | null;
            workspaceId: string;
          };
          surfaces: Array<{
            allowed: boolean;
            message: string;
            readState: string;
            reasonMessages: string[];
            reasons: string[];
            surface: string;
            writeAllowed: boolean;
          }>;
        };
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        principalId: string;
        scopeHash: string;
        workspaceId: string;
      };
      tool: {
        id: string;
        phase: string;
      };
    };

    expect(body.access).toMatchObject({
      allowed: true,
      toolId: "explainPermissions"
    });
    expect(body.tool).toMatchObject({
      id: "explainPermissions",
      phase: "draft"
    });
    expect(body.permissionScope).toEqual({
      policyRevision: 14,
      principalId: "agt_reviewer",
      scopeHash: "scope:view:view_private",
      workspaceId: "ws_1"
    });
    expect(body.output).toEqual({
      explanation: {
        evaluationContext: {
          principalAliases: {
            "row.owner": {
              alias: "row.owner",
              fieldId: "fld_owner",
              fieldKey: "owner",
              fieldType: "principal.user",
              matchesPrincipal: false,
              principalIds: ["usr_owner"],
              recordId: "rec_permission_owner_context"
            }
          },
          rowOwner: {
            alias: "row.owner",
            fieldId: "fld_owner",
            fieldKey: "owner",
            fieldType: "principal.user",
            matchesPrincipal: false,
            principalIds: ["usr_owner"],
            recordId: "rec_permission_owner_context"
          }
        },
        fieldId: "fld_secret_note",
        fieldType: "text.long",
        scope: {
          recordId: "rec_permission_owner_context",
          tableId: "tbl_1",
          viewId: "view_private",
          workspaceId: "ws_1"
        },
        surfaces: [
          {
            allowed: false,
            evaluationContext: {
              principalAliases: {
                "row.owner": {
                  alias: "row.owner",
                  fieldId: "fld_owner",
                  fieldKey: "owner",
                  fieldType: "principal.user",
                  matchesPrincipal: false,
                  principalIds: ["usr_owner"],
                  recordId: "rec_permission_owner_context"
                }
              },
              rowOwner: {
                alias: "row.owner",
                fieldId: "fld_owner",
                fieldKey: "owner",
                fieldType: "principal.user",
                matchesPrincipal: false,
                principalIds: ["usr_owner"],
                recordId: "rec_permission_owner_context"
              }
            },
            message: "Field is hidden for view queries. Row owner does not match the current principal.",
            readState: "hidden",
            reasonMessages: [
              "Field is hidden for view queries.",
              "Field is read-only for this principal."
            ],
            reasons: ["field_hidden:fld_secret_note", "field_read_only:fld_secret_note"],
            surface: "view-query",
            writeAllowed: false
          },
          {
            allowed: false,
            evaluationContext: {
              principalAliases: {
                "row.owner": {
                  alias: "row.owner",
                  fieldId: "fld_owner",
                  fieldKey: "owner",
                  fieldType: "principal.user",
                  matchesPrincipal: false,
                  principalIds: ["usr_owner"],
                  recordId: "rec_permission_owner_context"
                }
              },
              rowOwner: {
                alias: "row.owner",
                fieldId: "fld_owner",
                fieldKey: "owner",
                fieldType: "principal.user",
                matchesPrincipal: false,
                principalIds: ["usr_owner"],
                recordId: "rec_permission_owner_context"
              }
            },
            message: "Field is hidden for agent tools. Row owner does not match the current principal.",
            readState: "hidden",
            reasonMessages: [
              "Field is hidden for agent tools.",
              "Field is read-only for this principal."
            ],
            reasons: ["agent_hidden:fld_secret_note", "field_read_only:fld_secret_note"],
            surface: "agent-tool",
            writeAllowed: false
          }
        ]
      },
      kind: "permission-explanation"
    });
  });

  it("explains permission outcomes through the direct permission ingress in parity with the agent tool", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        owner: ["agt_reviewer"],
        secret_note: "hidden note",
        title: "Acme"
      },
      recordId: "rec_permission_owner_match",
      recordKey: "permission-owner-match",
      tableId: "tbl_1"
    });
    insertView(db, {
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1",
      workspaceId: "ws_1"
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
          recordId: "rec_permission_owner_match",
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
            recordId: "rec_permission_owner_match",
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

  it("surfaces field-declared principal aliases through the direct permission explanation ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        workflowBindingAlias: "row.assignee"
      },
      fieldId: "fld_assignee",
      fieldKey: "assignee",
      fieldType: "principal.user",
      label: "Assignee",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret_note",
      fieldKey: "secret_note",
      fieldType: "text.long",
      label: "Secret Note",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        assignee: ["agt_reviewer"],
        secret_note: "hidden note"
      },
      recordId: "rec_permission_assignee_match",
      recordKey: "permission-assignee-match",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      fields: {
        fld_secret_note: {
          agent: false,
          fieldId: "fld_secret_note",
          fieldType: "text.long",
          read: "hidden",
          workflow: false,
          write: false
        }
      },
      policyRevision: 14,
      principalId: "agt_reviewer",
      schemaEpoch: 1,
      scopeHash: "scope:table:tbl_1",
      snapshotId: "snap_table_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_secret_note",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 14,
          principalId: "agt_reviewer",
          recordId: "rec_permission_assignee_match",
          surfaces: ["command-ingress"],
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      explanation: {
        evaluationContext: {
          principalAliases: {
            "row.assignee": {
              alias: "row.assignee",
              fieldId: "fld_assignee",
              fieldKey: "assignee",
              fieldType: "principal.user",
              matchesPrincipal: true,
              principalIds: ["agt_reviewer"],
              recordId: "rec_permission_assignee_match"
            }
          }
        },
        fieldId: "fld_secret_note",
        fieldType: "text.long",
        scope: {
          recordId: "rec_permission_assignee_match",
          tableId: "tbl_1",
          viewId: null,
          workspaceId: "ws_1"
        },
        surfaces: [
          {
            allowed: false,
            evaluationContext: {
              principalAliases: {
                "row.assignee": {
                  alias: "row.assignee",
                  fieldId: "fld_assignee",
                  fieldKey: "assignee",
                  fieldType: "principal.user",
                  matchesPrincipal: true,
                  principalIds: ["agt_reviewer"],
                  recordId: "rec_permission_assignee_match"
                }
              }
            },
            message:
              "Field is hidden for command writes. Principal alias row.assignee matches the current principal.",
            readState: "hidden",
            reasonMessages: [
              "Field is hidden for command writes.",
              "Field is read-only for this principal."
            ],
            reasons: ["field_hidden:fld_secret_note", "field_read_only:fld_secret_note"],
            surface: "command-ingress",
            writeAllowed: false
          }
        ]
      },
      permissionScope: {
        policyRevision: 14,
        principalId: "agt_reviewer",
        scopeHash: "scope:table:tbl_1",
        workspaceId: "ws_1"
      }
    });
  });

  it("rejects stale permission coordinates on the direct permission explanation ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      fields: {
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
      schemaEpoch: 1,
      scopeHash: "scope:table:tbl_1",
      snapshotId: "snap_table_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_title",
          permissionScopeHash: "scope:missing",
          policyRevision: 14,
          principalId: "agt_reviewer",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: "bad_request",
      message: "Requested permissionScopeHash scope:missing does not match resolved scope scope:table:tbl_1."
    });
  });

  it("fails closed when the resolved permission snapshot cannot inspect the requested field", async () => {
    const { db, env } = createEnv();

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
    insertPermissionSnapshot(db, {
      fields: {
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
      schemaEpoch: 1,
      scopeHash: "scope:table:tbl_1",
      snapshotId: "snap_table_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_secret_note",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 14,
          principalId: "agt_reviewer",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { hiddenFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        hiddenFieldIds: ["fld_secret_note"]
      },
      error: "forbidden"
    });
  });

  it("explains redacted direct-ingress permission outcomes with canonical surface reasoning", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      fields: {
        fld_salary: {
          agent: true,
          fieldId: "fld_salary",
          fieldType: "number.decimal",
          read: "redacted",
          workflow: true,
          write: false
        }
      },
      policyRevision: 15,
      principalId: "usr_redacted",
      schemaEpoch: 1,
      scopeHash: "scope:table:tbl_1",
      snapshotId: "snap_table_redacted_salary",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_salary",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 15,
          principalId: "usr_redacted",
          surfaces: ["direct-record-read", "command-ingress"],
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      explanation: {
        fieldId: "fld_salary",
        fieldType: "number.decimal",
        scope: {
          recordId: null,
          tableId: "tbl_1",
          viewId: null,
          workspaceId: "ws_1"
        },
        surfaces: [
          {
            allowed: true,
            message: "Field value is redacted for direct record reads.",
            readState: "redacted",
            reasonMessages: [
              "Field value is redacted for direct record reads.",
              "Field is read-only for this principal."
            ],
            reasons: ["field_redacted:fld_salary", "field_read_only:fld_salary"],
            surface: "direct-record-read",
            writeAllowed: false
          },
          {
            allowed: true,
            message: "Field value is redacted for command writes.",
            readState: "redacted",
            reasonMessages: [
              "Field value is redacted for command writes.",
              "Field is read-only for this principal."
            ],
            reasons: ["field_redacted:fld_salary", "field_read_only:fld_salary"],
            surface: "command-ingress",
            writeAllowed: false
          }
        ]
      },
      permissionScope: {
        policyRevision: 15,
        principalId: "usr_redacted",
        scopeHash: "scope:table:tbl_1",
        workspaceId: "ws_1"
      }
    });
  });

  it("rejects invalid permission explanation coordinate types", async () => {
    const { env } = createEnv();

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/explain", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          fieldId: "fld_title",
          policyRevision: "oops",
          principalId: "usr_scope_check",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: "bad_request",
      message: "policyRevision must be a finite number when provided for permission explanation ingress."
    });
  });

  it("previews saved-view persona access through the agent tool preview ingress", async () => {
    const { db, env } = createEnv();

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
    insertView(db, {
      filters: [
        {
          fieldId: "fld_customer_note",
          operatorId: "equals",
          value: "vip"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title", "fld_salary", "fld_customer_note"]
    });
    insertRecordProjection(db, {
      fields: {
        customer_note: "vip",
        internal_note: "audit only",
        salary: 125000,
        title: "Acme"
      },
      recordId: "rec_001",
      recordKey: "acme",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      access: {
        allowed: boolean;
        toolId: string;
      };
      output: {
        kind: string;
        preview: {
          actions: {
            tools: Array<{
              allowed: boolean;
              reason: string | null;
              toolId: string;
            }>;
          };
          fields: Array<{
            configuredVisible: boolean;
            fieldId: string;
            hiddenByView: boolean;
            surfaces: {
              agentTool: {
                readState: string;
                writeAllowed: boolean;
              };
              commandIngress: {
                readState: string;
                writeAllowed: boolean;
              };
              viewQuery: {
                readState: string;
                writeAllowed: boolean;
              };
              workflowStep: {
                readState: string;
                writeAllowed: boolean;
              };
            };
          }>;
          principalId: string | null;
          rows: Array<{
            cells: Record<string, unknown>;
            redactedFieldIds: string[];
          }>;
          view: {
            filters: Array<Record<string, unknown>>;
            surfaces: {
              viewQuery: {
                hiddenFieldIds: string[];
                readOnlyFieldIds: string[];
                redactedFieldIds: string[];
              };
            };
            viewQuery: {
              redactedFieldIds: string[];
              visibleFieldIds: string[];
            };
          };
        } | null;
      };
      tool: {
        id: string;
        phase: string;
      };
    };

    expect(body.access).toMatchObject({
      allowed: true,
      toolId: "previewPermissionPersona"
    });
    expect(body.tool).toMatchObject({
      id: "previewPermissionPersona",
      phase: "preview"
    });
    expect(body.output.kind).toBe("permission-persona-preview");
    expect(body.output.preview).toMatchObject({
      principalId: "agt_reviewer",
      view: {
        filters: [
          {
            fieldId: "fld_customer_note",
            operatorId: "equals",
            protected: true
          }
        ],
        surfaces: {
          viewQuery: {
            hiddenFieldIds: ["fld_customer_note"],
            readOnlyFieldIds: expect.arrayContaining(["fld_salary", "fld_internal_note"]),
            redactedFieldIds: ["fld_salary"]
          }
        },
        viewQuery: {
          redactedFieldIds: ["fld_salary"],
          visibleFieldIds: ["fld_title", "fld_salary"]
        }
      }
    });
    expect(body.output.preview?.rows[0]).toMatchObject({
      cells: {
        fld_salary: "[redacted]",
        fld_title: "Acme"
      },
      redactedFieldIds: ["fld_salary"]
    });
    const hiddenField = body.output.preview?.fields.find((field) => field.fieldId === "fld_customer_note");
    const hiddenByViewField = body.output.preview?.fields.find((field) => field.fieldId === "fld_internal_note");
    expect(hiddenField).toMatchObject({
      configuredVisible: true,
      fieldId: "fld_customer_note",
      hiddenByView: false,
      surfaces: {
        agentTool: {
          readState: "hidden",
          writeAllowed: false
        },
        commandIngress: {
          readState: "hidden",
          writeAllowed: false
        },
        viewQuery: {
          readState: "hidden",
          writeAllowed: false
        },
        workflowStep: {
          readState: "hidden",
          writeAllowed: false
        }
      }
    });
    expect(hiddenByViewField).toMatchObject({
      configuredVisible: false,
      fieldId: "fld_internal_note",
      hiddenByView: true,
      surfaces: {
        commandIngress: {
          readState: "visible",
          writeAllowed: false
        }
      }
    });
    expect(body.output.preview?.actions.tools).toContainEqual(
      expect.objectContaining({
        allowed: true,
        mutating: true,
        toolId: "updateRecord"
      })
    );
    expect(body.output.preview?.actions.tools).toContainEqual(
      expect.objectContaining({
        allowed: true,
        toolId: "previewPermissionPersona"
      })
    );
  });

  it("previews saved-view persona access through the direct permission ingress in parity with the agent tool", async () => {
    const { db, env } = createEnv();

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
    insertView(db, {
      filters: [
        {
          fieldId: "fld_customer_note",
          operatorId: "equals",
          value: "vip"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title", "fld_salary", "fld_customer_note"]
    });
    insertRecordProjection(db, {
      fields: {
        customer_note: "vip",
        internal_note: "audit only",
        salary: 125000,
        title: "Acme"
      },
      recordId: "rec_001",
      recordKey: "acme",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1",
      workspaceId: "ws_1"
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

  it("rejects stale permission coordinates on the direct permission persona preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertView(db, {
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
      fields: {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_view_private_1",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/persona-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          permissionScopeHash: "scope:view:missing",
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

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: "bad_request",
      message:
        "Requested permissionScopeHash scope:view:missing does not match resolved scope scope:view:view_private."
    });
  });

  it("fails closed when direct permission persona preview coordinates do not resolve a scope snapshot", async () => {
    const { env } = createEnv();

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/persona-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          principalId: "agt_missing",
          tableId: "tbl_missing",
          viewId: "view_missing",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: "bad_request",
      message: "Permission snapshot could not be resolved for this request scope."
    });
  });

  it("rejects invalid permission persona preview coordinate types", async () => {
    const { env } = createEnv();

    const response = await handleFetch(
      new Request("https://example.test/v1/permissions/persona-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          policyRevision: "oops",
          principalId: "usr_scope_check",
          tableId: "tbl_1",
          viewId: "view_private",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string; message: string }).toMatchObject({
      error: "bad_request",
      message: "policyRevision must be a finite number when provided for permission persona preview ingress."
    });
  });

  it("routes permission-scoped saved-view reads through the queryView agent tool", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        secret_note: "private",
        title: "Acme"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertView(db, {
      filters: [],
      tableId: "tbl_1",
      viewId: "view_private",
      viewKey: "private",
      viewName: "Private Queue",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
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
      schemaEpoch: 1,
      scopeHash: "scope:view:view_private",
      snapshotId: "snap_query_view_agent",
      workspaceId: "ws_1"
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_private?workspaceId=ws_1&principalId=agt_reviewer&permissionScopeHash=scope:view:view_private&policyRevision=14"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
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
          policyRevision: 14,
          principalId: "agt_reviewer",
          toolId: "queryView",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        view: Record<string, unknown>;
      };
    };

    expect(agentBody.output).toEqual({
      kind: "view-query",
      view: directBody
    });
  });

  it("keeps owner-filtered saved-view query and definition surfaces in parity", async () => {
    const { db, env } = createEnv();

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
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        owner: ["usr_owner"],
        title: "Owned by owner"
      },
      recordId: "rec_owner_1",
      recordKey: "owner-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        owner: ["usr_member"],
        title: "Owned by member"
      },
      recordId: "rec_owner_2",
      recordKey: "owner-2",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_owner",
      recordId: "rec_owner_1",
      referenceValue: "usr_owner",
      tableId: "tbl_1",
      textValue: "usr_owner"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_owner",
      recordId: "rec_owner_2",
      referenceValue: "usr_member",
      tableId: "tbl_1",
      textValue: "usr_member"
    });

    insertView(db, {
      filters: [
        {
          fieldId: "fld_owner",
          operatorId: "equals",
          value: "usr_owner"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_owner_only",
      viewKey: "owner-only",
      viewName: "Owner Only",
      visibleFieldIds: ["fld_title", "fld_owner"]
    });
    insertView(db, {
      filters: [
        {
          fieldId: "fld_owner",
          operatorId: "equals",
          value: "usr_member"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_member_only",
      viewKey: "member-only",
      viewName: "Member Only",
      visibleFieldIds: ["fld_title", "fld_owner"]
    });

    const visibleOwnerField = {
      agent: true,
      fieldId: "fld_owner",
      fieldType: "principal.user",
      read: "visible",
      workflow: true,
      write: true
    } as const;
    const visibleTitleField = {
      agent: true,
      fieldId: "fld_title",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    } as const;

    insertPermissionSnapshot(db, {
      fields: {
        fld_owner: visibleOwnerField,
        fld_title: visibleTitleField
      },
      policyRevision: 51,
      principalId: "usr_owner",
      schemaEpoch: 1,
      scopeHash: "scope:view:view_owner_only",
      snapshotId: "snap_owner_view_owner_only",
      workspaceId: "ws_1"
    });
    insertPermissionSnapshot(db, {
      fields: {
        fld_owner: visibleOwnerField,
        fld_title: visibleTitleField
      },
      policyRevision: 52,
      principalId: "usr_member",
      schemaEpoch: 1,
      scopeHash: "scope:view:view_member_only",
      snapshotId: "snap_member_view_member_only",
      workspaceId: "ws_1"
    });

    const ownerDirectResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_owner_only?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:view:view_owner_only&policyRevision=51"
      ),
      env,
      {} as ExecutionContext
    );
    const memberDirectResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_member_only?workspaceId=ws_1&principalId=usr_member&permissionScopeHash=scope:view:view_member_only&policyRevision=52"
      ),
      env,
      {} as ExecutionContext
    );
    const ownerAgentQueryResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            viewId: "view_owner_only"
          },
          permissionScopeHash: "scope:view:view_owner_only",
          policyRevision: 51,
          principalId: "usr_owner",
          toolId: "queryView",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const ownerDefinitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_owner_only/definition?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:view:view_owner_only&policyRevision=51"
      ),
      env,
      {} as ExecutionContext
    );
    const ownerAgentDefinitionResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            viewId: "view_owner_only"
          },
          permissionScopeHash: "scope:view:view_owner_only",
          policyRevision: 51,
          principalId: "usr_owner",
          toolId: "inspectViewDefinition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(ownerDirectResponse.status).toBe(200);
    expect(memberDirectResponse.status).toBe(200);
    expect(ownerAgentQueryResponse.status).toBe(200);
    expect(ownerDefinitionResponse.status).toBe(200);
    expect(ownerAgentDefinitionResponse.status).toBe(200);

    const ownerDirectBody = (await ownerDirectResponse.json()) as {
      rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
    };
    const memberDirectBody = (await memberDirectResponse.json()) as {
      rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
    };
    const ownerAgentQueryBody = (await ownerAgentQueryResponse.json()) as {
      output: {
        kind: string;
        view: Record<string, unknown>;
      };
    };
    const ownerDefinitionBody = (await ownerDefinitionResponse.json()) as Record<string, unknown>;
    const ownerAgentDefinitionBody = (await ownerAgentDefinitionResponse.json()) as {
      output: {
        kind: string;
        view: Record<string, unknown>;
      };
    };

    expect(ownerDirectBody.rows).toEqual([
      {
        cells: {
          fld_owner: ["usr_owner"],
          fld_title: "Owned by owner"
        },
        hiddenFieldIds: [],
        recordId: "rec_owner_1",
        recordKey: "owner-1",
        redactedFieldIds: [],
        states: {
          fld_owner: "visible",
          fld_title: "visible"
        }
      }
    ]);
    expect(memberDirectBody.rows).toEqual([
      {
        cells: {
          fld_owner: ["usr_member"],
          fld_title: "Owned by member"
        },
        hiddenFieldIds: [],
        recordId: "rec_owner_2",
        recordKey: "owner-2",
        redactedFieldIds: [],
        states: {
          fld_owner: "visible",
          fld_title: "visible"
        }
      }
    ]);
    expect(ownerAgentQueryBody.output).toEqual({
      kind: "view-query",
      view: ownerDirectBody
    });
    expect(ownerDefinitionBody).toMatchObject({
      definition: {
        filters: [
          {
            fieldId: "fld_owner",
            operatorId: "equals",
            protected: false,
            value: "usr_owner"
          }
        ]
      }
    });
    expect(ownerAgentDefinitionBody.output).toEqual({
      kind: "view-definition-inspection",
      view: ownerDefinitionBody
    });
  });

  it("routes permission-scoped table schema reads through the inspectTableSchema agent tool", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        precision: 2
      },
      fieldId: "fld_beta",
      fieldKey: "estimate",
      fieldType: "number.decimal",
      label: "Estimate",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        required: true
      },
      fieldId: "fld_alpha",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_table_schema",
      workspaceId: "ws_1",
      principalId: "agt_table_schema",
      policyRevision: 38,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_alpha: {
          agent: true,
          fieldId: "fld_alpha",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_beta: {
          agent: true,
          fieldId: "fld_beta",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=agt_table_schema&permissionScopeHash=scope:table:tbl_1&policyRevision=38"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 38,
          principalId: "agt_table_schema",
          toolId: "inspectTableSchema",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        schema: Record<string, unknown>;
      };
    };

    expect(agentBody.output).toEqual({
      kind: "table-schema-inspection",
      schema: directBody
    });
  });

  it("routes permission-scoped saved-view definition reads through the inspectViewDefinition agent tool", async () => {
    const { db, env } = createEnv();

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
    insertField(db, {
      fieldId: "fld_priority",
      fieldKey: "priority",
      fieldType: "number.decimal",
      label: "Priority",
      tableId: "tbl_1"
    });
    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "in_progress"
        }
      ],
      groupByFieldId: "fld_priority",
      sorts: [
        {
          fieldId: "fld_priority",
          mode: "descending"
        },
        {
          fieldId: "fld_title",
          mode: "ascending"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_title", "fld_status", "fld_priority"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_view_definition",
      workspaceId: "ws_1",
      principalId: "agt_view_definition",
      policyRevision: 39,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_pipeline",
      fields: {
        fld_priority: {
          agent: true,
          fieldId: "fld_priority",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "redacted",
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
      }
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_pipeline/definition?workspaceId=ws_1&principalId=agt_view_definition&permissionScopeHash=scope:view:view_pipeline&policyRevision=39"
      ),
      env,
      {} as ExecutionContext
    );
    const agentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            viewId: "view_pipeline"
          },
          permissionScopeHash: "scope:view:view_pipeline",
          policyRevision: 39,
          principalId: "agt_view_definition",
          toolId: "inspectViewDefinition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as Record<string, unknown>;
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        view: Record<string, unknown>;
      };
    };

    expect(agentBody.output).toEqual({
      kind: "view-definition-inspection",
      view: directBody
    });
  });

  it("returns serialized scaffold manifests through the internal scaffold ingress", async () => {
    const { env } = createEnv();

    const response = await handleFetch(
      new Request("https://example.test/internal/scaffold"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aggregateOperations: Array<Record<string, unknown>>;
      agentTools: Array<Record<string, unknown>>;
      fieldTypes: Array<Record<string, unknown>>;
      workflowOperators: Array<Record<string, unknown>>;
    };

    expect(body.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "max_number",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "average_numbers",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line"))
    );
    expect(body.workflowOperators).toContainEqual(
      serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("manual"))
    );
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "command-bus",
          operation: "dry-run"
        },
        id: "dryRunCommand",
        successorToolId: "executeCommand"
      })
    );
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "query-service",
          service: "tableSchemaInspector"
        },
        id: "inspectTableSchema"
      })
    );
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "query-service",
          service: "viewDefinitionInspector"
        },
        id: "inspectViewDefinition"
      })
    );
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "query-service",
          service: "workflowDefinitionInspector"
        },
        id: "inspectWorkflowDefinition"
      })
    );
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "workflow-operation",
          operation: "replay-dead-letter"
        },
        id: "prepareWorkflowDeadLetterReplay",
        successorToolId: "requestWorkflowDeadLetterReplay"
      })
    );
    expect(body.fieldTypes[0]).not.toHaveProperty("normalize");
    const scaffoldTool = body.agentTools.find((tool) => tool.id === "inspectWorkspace");
    expect(scaffoldTool).toBeDefined();
    expect(scaffoldTool).not.toHaveProperty("invoke");
  });

  it("returns real inspectWorkspace metadata through the worker ingress", async () => {
    const { db, env } = createEnv();

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
    insertView(db, {
      tableId: "tbl_1",
      viewId: "view_open",
      viewKey: "open",
      viewName: "Open Work",
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          }
        }
      },
      name: "Pause Pipeline",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_pipeline",
      workflowKey: "pipeline"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_inspect",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 21,
      schemaEpoch: 1,
      scopeHash: "scope:agent:inspect",
      fields: {
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
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            workspaceId: "ws_1"
          },
          principalId: "agt_assist",
          toolId: "inspectWorkspace",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      input: {
        workspaceId: string;
      };
      output: {
        kind: string;
        workspace: {
          apps: Array<{
            appId: string;
            name: string;
            slug: string;
            tableIds: string[];
          }>;
          catalog: {
            aggregateOperations: Array<Record<string, unknown>>;
            agentTools: Array<Record<string, unknown>>;
            fieldTypes: Array<Record<string, unknown>>;
            workflowOperators: Array<Record<string, unknown>>;
          };
          tables: Array<{
            fieldIds: string[];
            name: string;
            tableId: string;
            viewIds: string[];
          }>;
          views: Array<{
            name: string;
            tableId: string;
            viewId: string;
          }>;
          workflows: Array<{
            name: string;
            status: string;
            tableId: string;
            workflowId: string;
          }>;
          workspaceId: string;
        };
      };
    };

    expect(body.input).toEqual({
      workspaceId: "ws_1"
    });
    expect(body.output).toMatchObject({
      kind: "workspace-inspection",
      workspace: {
        apps: [
          {
            appId: "app_1",
            name: "App 1",
            slug: "app-1",
            tableIds: ["tbl_1"]
          }
        ],
        tables: [
          {
            fieldIds: ["fld_status", "fld_title"],
            name: "Table 1",
            tableId: "tbl_1",
            viewIds: ["view_open"]
          }
        ],
        views: [
          {
            name: "Open Work",
            tableId: "tbl_1",
            viewId: "view_open"
          }
        ],
        workflows: [
          {
            name: "Pause Pipeline",
            status: "paused",
            tableId: "tbl_1",
            workflowId: "wf_pipeline"
          }
        ],
        workspaceId: "ws_1"
      }
    });
    expect(body.output.workspace.catalog.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line"))
    );
    expect(body.output.workspace.catalog.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "max_number",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.output.workspace.catalog.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "average_numbers",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.output.workspace.catalog.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "query-service",
          service: "workspaceInspector"
        },
        fieldBinding: "none",
        id: "inspectWorkspace",
        mutating: false,
        mutationTarget: "none",
        phase: "draft",
        requiresConfirmation: false,
        scope: "app"
      })
    );
    expect(body.output.workspace.catalog.workflowOperators).toContainEqual(
      serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("manual"))
    );
    expect(body.output.workspace.catalog.workflowOperators).toContainEqual(
      serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("equals"))
    );
    expect(body.output.workspace.catalog.workflowOperators).toContainEqual(
      serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("send_webhook"))
    );
    expect(body.output.workspace.catalog.fieldTypes[0]).not.toHaveProperty("fixtures");
    const conditionOperator = body.output.workspace.catalog.workflowOperators.find(
      (operator) => operator.id === "equals"
    );
    expect(conditionOperator).toBeDefined();
    expect(conditionOperator).not.toHaveProperty("evaluate");
    const actionOperator = body.output.workspace.catalog.workflowOperators.find(
      (operator) => operator.id === "send_webhook"
    );
    expect(actionOperator).toBeDefined();
    expect(actionOperator).not.toHaveProperty("createCommand");
    const inspectWorkspaceTool = body.output.workspace.catalog.agentTools.find(
      (tool) => tool.id === "inspectWorkspace"
    );
    expect(inspectWorkspaceTool).toBeDefined();
    expect(inspectWorkspaceTool).not.toHaveProperty("invoke");
  });

  it("returns real workspace catalog metadata through the worker read ingress", async () => {
    const { db, env } = createEnv();

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
    insertView(db, {
      tableId: "tbl_1",
      viewId: "view_open",
      viewKey: "open",
      viewName: "Open Work",
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          }
        }
      },
      name: "Pause Pipeline",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_pipeline",
      workflowKey: "pipeline"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workspace_catalog_operator",
      workspaceId: "ws_1",
      principalId: "ops_catalog",
      policyRevision: 31,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/catalog?principalId=ops_catalog&permissionScopeHash=scope:workspace&policyRevision=31"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apps: Array<{
        appId: string;
        name: string;
        tableIds: string[];
      }>;
      catalog: {
        aggregateOperations: Array<Record<string, unknown>>;
        agentTools: Array<Record<string, unknown>>;
        fieldTypes: Array<Record<string, unknown>>;
      };
      tables: Array<{
        fieldIds: string[];
        name: string;
        tableId: string;
        viewIds: string[];
      }>;
      views: Array<{
        name: string;
        tableId: string;
        viewId: string;
      }>;
      workflows: Array<{
        name: string;
        status: string;
        tableId: string;
        workflowId: string;
      }>;
      workspaceId: string;
    };

    expect(body).toMatchObject({
      apps: [
        {
          appId: "app_1",
          name: "App 1",
          slug: "app-1",
          tableIds: ["tbl_1"]
        }
      ],
      tables: [
        {
          fieldIds: ["fld_status", "fld_title"],
          name: "Table 1",
          tableId: "tbl_1",
          viewIds: ["view_open"]
        }
      ],
      views: [
        {
          name: "Open Work",
          tableId: "tbl_1",
          viewId: "view_open"
        }
      ],
      workflows: [
        {
          name: "Pause Pipeline",
          status: "paused",
          tableId: "tbl_1",
          workflowId: "wf_pipeline"
        }
      ],
      workspaceId: "ws_1"
    });
    expect(body.catalog.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line"))
    );
    expect(body.catalog.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "max_number",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.catalog.aggregateOperations).toContainEqual(
      expect.objectContaining({
        id: "average_numbers",
        operand: expect.objectContaining({
          required: true,
          valueType: "number"
        })
      })
    );
    expect(body.catalog.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "command-bus",
          operation: "execute"
        },
        id: "executeCommand",
        mutationTarget: "command",
        phase: "execute",
        requiresConfirmation: true
      })
    );
    expect(body.catalog.fieldTypes[0]).not.toHaveProperty("normalize");
  });

  it("denies workspace catalog reads when the principal lacks workflow operator access", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workspace_catalog_denied",
      workspaceId: "ws_1",
      principalId: "usr_catalog_denied",
      policyRevision: 32,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["record.create"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/catalog?principalId=usr_catalog_denied&permissionScopeHash=scope:workspace&policyRevision=32"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "forbidden"
    });
  });

  it("provisions and reads workspace membership identity through the worker ingress", async () => {
    const { env } = createEnv();

    const provisionResponse = await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_member_identity",
      roleKey: "workspace.admin",
      userId: "user_identity"
    });

    expect(provisionResponse.status).toBe(200);
    const provisionBody = (await provisionResponse.json()) as {
      membership: {
        organizationId: string;
        principalId: string;
        userId: string;
        workspacePrincipalId: string | null;
      };
    };
    expect(provisionBody.membership).toMatchObject({
      organizationId: "org_1",
      principalId: "usr_member_identity",
      userId: "user_identity",
      workspacePrincipalId: "principal:ws_1:usr_member_identity"
    });

    const readResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/memberships/usr_member_identity"),
      env,
      {} as ExecutionContext
    );
    expect(readResponse.status).toBe(200);
    const readBody = (await readResponse.json()) as {
      membership: {
        principalId: string;
        workspaceRoleKey: string;
      };
    };
    expect(readBody.membership).toMatchObject({
      principalId: "usr_member_identity",
      workspaceRoleKey: "workspace.admin"
    });
  });

  it("lists current-user tenants and admin-only workspace memberships", async () => {
    const { env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_admin_identity",
      roleKey: "workspace.admin",
      userId: "user_admin_identity"
    });
    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_member_identity",
      roleKey: "workspace.member",
      userId: "user_member_identity"
    });

    const adminCookie = await createAuthenticatedCookie(env, "user_admin_identity", {
      activeWorkspaceId: "ws_1"
    });
    const tenantResponse = await handleFetch(
      new Request("https://example.test/v1/tenants", {
        headers: {
          cookie: adminCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(tenantResponse.status).toBe(200);
    expect(
      (await tenantResponse.json()) as {
        tenants: Array<{ admin: boolean; workspace: { name: string; slug: string } }>;
      }
    ).toMatchObject({
      tenants: [
        {
          admin: true,
          workspace: {
            name: "Workspace 1",
            slug: "workspace-1"
          }
        }
      ]
    });

    const listResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/memberships", {
        headers: {
          cookie: adminCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(listResponse.status).toBe(200);
    expect(
      (await listResponse.json()) as {
        memberships: Array<{ principalId: string; workspaceRoleKey: string }>;
      }
    ).toMatchObject({
      memberships: expect.arrayContaining([
        expect.objectContaining({
          principalId: "usr_admin_identity",
          workspaceRoleKey: "workspace.admin"
        }),
        expect.objectContaining({
          principalId: "usr_member_identity",
          workspaceRoleKey: "workspace.member"
        })
      ])
    });

    const memberCookie = await createAuthenticatedCookie(env, "user_member_identity");
    const forbiddenListResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/memberships", {
        headers: {
          cookie: memberCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(forbiddenListResponse.status).toBe(403);
  });

  it("requires workspace admins, valid roles, and no duplicate pending invitations", async () => {
    const { env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_member_inviter",
      roleKey: "workspace.member",
      userId: "user_member_inviter"
    });
    const memberCookie = await createAuthenticatedCookie(env, "user_member_inviter");
    const memberInviteResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: memberCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(memberInviteResponse.status).toBe(403);

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_admin_inviter",
      roleKey: "workspace.admin",
      userId: "user_admin_inviter"
    });
    const adminCookie = await createAuthenticatedCookie(env, "user_admin_inviter");
    const invalidRoleResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable",
          roleKey: "workspace.owner"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidRoleResponse.status).toBe(400);

    const firstInviteResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(firstInviteResponse.status).toBe(201);

    const duplicateInviteResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "INVITEE@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(duplicateInviteResponse.status).toBe(409);
  });

  it("issues invitations for an authenticated member and accepts them through Google callback", async () => {
    const { db, env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_inviter",
      roleKey: "workspace.admin",
      userId: "user_inviter"
    });
    const inviterCookie = await createAuthenticatedCookie(env, "user_inviter");

    const issueResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: inviterCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(issueResponse.status).toBe(201);
    const issueBody = (await issueResponse.json()) as {
      invitation: {
        acceptUrl: string;
        id: string;
        invitedEmail: string;
        roleKey: string;
        status: string;
      };
    };
    expect(issueBody.invitation).toMatchObject({
      invitedEmail: "invitee@example.com",
      roleKey: "workspace.member",
      status: "pending"
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "invitee@example.com",
            name: "Invitee",
            sub: "google-oauth2|invitee"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const loginResponse = await handleFetch(
      new Request(issueBody.invitation.acceptUrl),
      env,
      {} as ExecutionContext
    );
    expect(loginResponse.status).toBe(302);
    const googleRedirect = new URL(loginResponse.headers.get("location") ?? "");
    const state = googleRedirect.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(302);
    const inviteeCookie = readCookieHeaderFromSetCookie(callbackResponse.headers.get("set-cookie") ?? "");

    const sessionResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session?workspaceId=ws_1", {
        headers: {
          cookie: inviteeCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      activeWorkspaceId: string | null;
      activeWorkspaceMembership: { workspaceId: string } | null;
      session: { userEmail: string | null; userId: string };
      workspaceMembership: { organizationId: string; principalId: string; userId: string };
    };
    expect(sessionBody.session.userId).not.toBe("user_inviter");
    expect(sessionBody.session.userEmail).toBe("invitee@example.com");
    expect(sessionBody.activeWorkspaceId).toBe("ws_1");
    expect(sessionBody.activeWorkspaceMembership?.workspaceId).toBe("ws_1");
    expect(sessionBody.workspaceMembership.organizationId).toBe("org_1");
    expect(sessionBody.workspaceMembership.userId).toBe(sessionBody.session.userId);
    expect(sessionBody.workspaceMembership.principalId).toMatch(/^usr_/);

    const invitationRow = await db
      .prepare(
        `SELECT status, accepted_by_user_id
         FROM invitations
         WHERE id = ?`
      )
      .bind(issueBody.invitation.id)
      .first<{ accepted_by_user_id: string | null; status: string }>();
    expect(invitationRow).toEqual({
      accepted_by_user_id: sessionBody.session.userId,
      status: "accepted"
    });
  });

  it("prioritizes the invited workspace for cross-organization invitees and still allows session switching", async () => {
    const { db, env } = createEnv();
    seedWorkspace(db, "ws_2");

    const existingMembershipResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_2/memberships", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          membership: {
            organizationMembershipId: "orgmem:user_cross_org:ws_2",
            principalId: "usr_cross_org_existing",
            roleKey: "workspace.member",
            workspaceMembershipId: "wsmem:user_cross_org:ws_2"
          },
          organization: {
            id: "org_2",
            name: "Org 2",
            slug: "org-2"
          },
          timestamp: "2026-06-10T00:00:00.000Z",
          user: {
            displayName: "user_cross_org",
            email: "invitee@example.com",
            id: "user_cross_org"
          },
          workspace: {
            name: "Workspace 2",
            slug: "workspace-2"
          }
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(existingMembershipResponse.status).toBe(200);

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_inviter",
      roleKey: "workspace.admin",
      userId: "user_inviter"
    });
    const inviterCookie = await createAuthenticatedCookie(env, "user_inviter");

    const issueResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: inviterCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(issueResponse.status).toBe(201);
    const issueBody = (await issueResponse.json()) as {
      invitation: {
        acceptUrl: string;
        id: string;
      };
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "invitee@example.com",
            name: "Invitee",
            sub: "google-oauth2|invitee"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const loginResponse = await handleFetch(
      new Request(issueBody.invitation.acceptUrl),
      env,
      {} as ExecutionContext
    );
    expect(loginResponse.status).toBe(302);
    const googleRedirect = new URL(loginResponse.headers.get("location") ?? "");
    const state = googleRedirect.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(302);
    const inviteeCookie = readCookieHeaderFromSetCookie(callbackResponse.headers.get("set-cookie") ?? "");

    const invitedWorkspaceSessionResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session", {
        headers: {
          cookie: inviteeCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(invitedWorkspaceSessionResponse.status).toBe(200);
    const invitedWorkspaceSessionBody = (await invitedWorkspaceSessionResponse.json()) as {
      activeOrganization: { organizationId: string } | null;
      activeWorkspaceId: string | null;
      memberships: Array<{ organizationId: string; workspaceId: string }>;
      session: { activeWorkspaceId: string | null; userId: string };
      workspaceMembership: { organizationId: string; workspaceId: string };
    };
    expect(invitedWorkspaceSessionBody).toMatchObject({
      activeOrganization: { organizationId: "org_1" },
      activeWorkspaceId: "ws_1",
      session: {
        activeWorkspaceId: "ws_1",
        userId: "user_cross_org"
      },
      workspaceMembership: {
        organizationId: "org_1",
        workspaceId: "ws_1"
      }
    });
    expect(invitedWorkspaceSessionBody.memberships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ organizationId: "org_1", workspaceId: "ws_1" }),
        expect.objectContaining({ organizationId: "org_2", workspaceId: "ws_2" })
      ])
    );

    const switchResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session/selection", {
        method: "POST",
        headers: {
          cookie: inviteeCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_2"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(switchResponse.status).toBe(200);
    expect(
      (await switchResponse.json()) as {
        activeOrganization: { organizationId: string };
        activeWorkspaceId: string | null;
        session: { activeWorkspaceId: string | null };
        workspaceMembership: { principalId: string; workspaceId: string };
      }
    ).toMatchObject({
      activeOrganization: { organizationId: "org_2" },
      activeWorkspaceId: "ws_2",
      session: { activeWorkspaceId: "ws_2" },
      workspaceMembership: {
        principalId: "usr_cross_org_existing",
        workspaceId: "ws_2"
      }
    });

    const invitationRow = await db
      .prepare(
        `SELECT status, accepted_by_user_id
         FROM invitations
         WHERE id = ?`
      )
      .bind(issueBody.invitation.id)
      .first<{ accepted_by_user_id: string | null; status: string }>();
    expect(invitationRow).toEqual({
      accepted_by_user_id: "user_cross_org",
      status: "accepted"
    });
  });

  it("keeps invited-member reactive saved-view readback and persona-preview surfaces in parity", async () => {
    const {
      aggregateQueue,
      db,
      env,
      eventFanoutQueue,
      workflowDispatchQueue
    } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );

    insertField(db, {
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      },
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_account_name",
      fieldKey: "account_name",
      fieldType: "text.single_line",
      label: "Account Name",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      config: {
        resultValueType: "number",
        rollup: {
          grouping: {
            sourceFieldId: "fld_ticket_account",
            strategy: "single_relation"
          },
          operandFieldId: "fld_ticket_amount",
          operationId: "sum_numbers",
          sourceTableId: "tbl_1"
        }
      },
      fieldId: "fld_account_revenue_rollup",
      fieldKey: "ticket_revenue_rollup",
      fieldType: "computed.readonly",
      label: "Ticket Revenue Rollup",
      tableId: "tbl_accounts"
    });

    insertRecordProjection(db, {
      fields: {
        amount: 10,
        account: ["rec_account_1"]
      },
      recordId: "rec_ticket_1",
      recordKey: "ticket-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        account_name: "Acme Corp",
        ticket_revenue_rollup: null
      },
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account_name",
      fieldKey: "account_name",
      fieldType: "text.single_line",
      recordId: "rec_account_1",
      tableId: "tbl_accounts",
      value: "Acme Corp"
    });
    insertCellCurrent(db, {
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: ["rec_account_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 10
    });

    insertWorkflow(db, {
      definition: {
        actions: [],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "account_revenue_sum",
              dependencyFieldIds: ["fld_ticket_account", "fld_ticket_amount"],
              groupingSource: {
                kind: "related_record",
                resolverAlias: "account",
                sourceFieldId: "fld_ticket_account"
              },
              operand: {
                fieldId: "fld_ticket_amount",
                kind: "source_field",
                valueType: "number"
              },
              operationConfig: {},
              operationId: "sum_numbers",
              sourceRelationPath: "relatedTables.account",
              targetFieldId: "fld_account_revenue_rollup"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "account",
              sourceFieldId: "fld_ticket_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "published",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 7,
          principalId: "wf_invitation_grouped_sum",
          schemaEpoch: 0,
          scopeHash: "scope:wf:invitation-grouped-sum"
        },
        trigger: {
          match: {
            fieldId: "fld_ticket_amount",
            fromWorkflow: false,
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        }
      },
      name: "Invitation grouped sum",
      publishedAt: "2026-06-10T00:05:00.000Z",
      workflowId: "wf_invitation_grouped_sum",
      workflowKey: "invitation-grouped-sum"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_invitation_grouped_sum_workflow",
      principalId: "wf_invitation_grouped_sum",
      policyRevision: 7,
      schemaEpoch: 0,
      scopeHash: "scope:wf:invitation-grouped-sum",
      workspaceId: "ws_1",
      commandTypes: ["cell.set"],
      fields: {
        fld_account_revenue_rollup: {
          agent: false,
          fieldId: "fld_account_revenue_rollup",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertView(db, {
      tableId: "tbl_accounts",
      viewId: "view_account_rollups",
      viewKey: "account-rollups",
      viewName: "Account Rollups",
      visibleFieldIds: ["fld_account_name", "fld_account_revenue_rollup"]
    });
    insertEventLedgerEntry(db, {
      actor: {
        mode: "workflow",
        principalId: "wf_invitation_grouped_sum"
      },
      aggregateId: "wf_invitation_grouped_sum",
      aggregateType: "workflow",
      commandId: "cmd_publish_invitation_grouped_sum",
      commandType: "workflow.publish",
      createdAt: "2026-06-10T00:05:00.000Z",
      eventId: "evt_publish_invitation_grouped_sum",
      eventType: "workflow.published",
      payload: {
        workflowId: "wf_invitation_grouped_sum"
      },
      tableId: "tbl_1",
      tableSequence: 1,
      workspaceSequence: 1
    });

    await handleQueueBatch(
      createBatch([
        {
          eventId: "evt_publish_invitation_grouped_sum",
          kind: "event-fanout",
          payload: {
            eventId: "evt_publish_invitation_grouped_sum"
          },
          workspaceId: "ws_1"
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );
    expect(aggregateQueue.sent).toHaveLength(1);

    await handleQueueBatch(
      createBatch([aggregateQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(
      JSON.parse(
        (
          db.inner
            .prepare(
              `SELECT value_json
               FROM cell_current
               WHERE table_id = ? AND record_id = ? AND field_id = ?`
            )
            .get("tbl_accounts", "rec_account_1", "fld_account_revenue_rollup") as {
            value_json: string;
          }
        ).value_json
      )
    ).toMatchObject({
      isEmpty: false,
      raw: 10,
      valueType: "computed.readonly",
      version: 1
    });

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_inviter",
      roleKey: "workspace.admin",
      userId: "user_inviter"
    });
    const inviterCookie = await createAuthenticatedCookie(env, "user_inviter");

    const invitationResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_1/invitations", {
        method: "POST",
        headers: {
          cookie: inviterCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "invitee@example.com",
          redirectTo: "https://app.example.test/cloudtable"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(invitationResponse.status).toBe(201);
    const invitationBody = (await invitationResponse.json()) as {
      invitation: { acceptUrl: string; id: string };
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "invitee@example.com",
            name: "Invitee",
            sub: "google-oauth2|invitee"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const loginResponse = await handleFetch(
      new Request(invitationBody.invitation.acceptUrl),
      env,
      {} as ExecutionContext
    );
    expect(loginResponse.status).toBe(302);
    const state = new URL(loginResponse.headers.get("location") ?? "").searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(302);
    const inviteeCookie = readCookieHeaderFromSetCookie(callbackResponse.headers.get("set-cookie") ?? "");

    const sessionResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session?workspaceId=ws_1", {
        headers: {
          cookie: inviteeCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      session: { userEmail: string | null; userId: string };
      workspaceMembership: { principalId: string; userId: string };
    };
    expect(sessionBody.session.userEmail).toBe("invitee@example.com");
    expect(sessionBody.workspaceMembership.userId).toBe(sessionBody.session.userId);
    expect(sessionBody.workspaceMembership.principalId).toMatch(/^usr_/);

    insertPermissionSnapshot(db, {
      snapshotId: "snap_invited_member_grouped_sum_command",
      principalId: sessionBody.workspaceMembership.principalId,
      policyRevision: 63,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      workspaceId: "ws_1",
      commandTypes: ["cell.set"],
      fields: {
        fld_ticket_amount: {
          agent: true,
          fieldId: "fld_ticket_amount",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_invited_member_grouped_sum_view_read",
      principalId: sessionBody.workspaceMembership.principalId,
      policyRevision: 64,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_account_rollups",
      workspaceId: "ws_1",
      commandTypes: [],
      fields: {
        fld_account_name: {
          agent: true,
          fieldId: "fld_account_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: false,
          write: false
        },
        fld_account_revenue_rollup: {
          agent: true,
          fieldId: "fld_account_revenue_rollup",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: false,
          write: false
        }
      }
    });

    const commandResponse = await handleFetch(
      new Request("https://example.test/v1/commands/execute", {
        method: "POST",
        headers: {
          cookie: inviteeCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user"
          },
          commandId: "cmd_invited_member_grouped_sum",
          commandType: "cell.set",
          idempotencyKey: "idem_invited_member_grouped_sum",
          payload: {
            fieldId: "fld_ticket_amount",
            fieldType: "number.decimal",
            recordId: "rec_ticket_1",
            value: 35
          },
          scope: "table",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(commandResponse.status).toBe(200);
    expect(eventFanoutQueue.sent).toHaveLength(2);

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(workflowDispatchQueue.sent).toHaveLength(2);
    expect(aggregateQueue.sent).toHaveLength(2);

    await handleQueueBatch(
      createBatch([aggregateQueue.sent[1]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const savedViewResponse = await handleFetch(
      new Request(
        `https://example.test/v1/tables/tbl_accounts/views/view_account_rollups?workspaceId=ws_1&principalId=${sessionBody.workspaceMembership.principalId}&permissionScopeHash=scope:view:view_account_rollups&policyRevision=64`
      ),
      env,
      {} as ExecutionContext
    );
    expect(savedViewResponse.status).toBe(200);
    const savedViewBody = (await savedViewResponse.json()) as {
      rows: Array<{
        cells: Record<string, unknown>;
        redactedFieldIds: string[];
      }>;
      view: {
        redactedFieldIds: string[];
        visibleFieldIds: string[];
      };
    };

    const personaPreviewResponse = await handleFetch(
      new Request("https://example.test/v1/permissions/persona-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          permissionScopeHash: "scope:view:view_account_rollups",
          policyRevision: 64,
          principalId: sessionBody.workspaceMembership.principalId,
          tableId: "tbl_accounts",
          viewId: "view_account_rollups",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(personaPreviewResponse.status).toBe(200);
    const personaPreviewBody = (await personaPreviewResponse.json()) as {
      preview: {
        fields: Array<{
          fieldId: string;
          surfaces: {
            viewQuery: {
              readState: string;
              writeAllowed: boolean;
            };
          };
        }>;
        rows: Array<{
          cells: Record<string, unknown>;
          redactedFieldIds: string[];
        }>;
        view: {
          viewQuery: {
            redactedFieldIds: string[];
            visibleFieldIds: string[];
          };
        };
      } | null;
    };

    expect(savedViewBody).toMatchObject({
      rows: [
        {
          cells: {
            fld_account_name: "Acme Corp",
            fld_account_revenue_rollup: 35
          },
          redactedFieldIds: []
        }
      ],
      view: {
        redactedFieldIds: [],
        visibleFieldIds: ["fld_account_name", "fld_account_revenue_rollup"]
      }
    });
    expect(personaPreviewBody.preview).toMatchObject({
      rows: savedViewBody.rows,
      view: {
        viewQuery: savedViewBody.view
      }
    });
    expect(
      personaPreviewBody.preview?.fields.find((field) => field.fieldId === "fld_account_revenue_rollup")
    ).toMatchObject({
      fieldId: "fld_account_revenue_rollup",
      surfaces: {
        viewQuery: {
          readState: "visible",
          writeAllowed: false
        }
      }
    });
    expect(JSON.stringify(personaPreviewBody.preview)).not.toContain("fld_ticket_amount");

    const invitationRow = await db
      .prepare(
        `SELECT status, accepted_by_user_id
         FROM invitations
         WHERE id = ?`
      )
      .bind(invitationBody.invitation.id)
      .first<{ accepted_by_user_id: string | null; status: string }>();
    expect(invitationRow).toEqual({
      accepted_by_user_id: sessionBody.session.userId,
      status: "accepted"
    });
  });

  it("persists active workspace selection for multi-membership users through session switching", async () => {
    const { db, env } = createEnv();
    seedWorkspace(db, "ws_2");

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_multi_primary",
      userId: "user_multi"
    });

    const secondaryMembershipResponse = await handleFetch(
      new Request("https://example.test/v1/workspaces/ws_2/memberships", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          membership: {
            organizationMembershipId: "orgmem:user_multi:ws_2",
            principalId: "usr_multi_secondary",
            roleKey: "workspace.member",
            workspaceMembershipId: "wsmem:user_multi:ws_2"
          },
          organization: {
            id: "org_2",
            name: "Org 2",
            slug: "org-2"
          },
          timestamp: "2026-06-10T00:00:00.000Z",
          user: {
            displayName: "user_multi",
            email: "user_multi@example.com",
            id: "user_multi"
          },
          workspace: {
            name: "Workspace 2",
            slug: "workspace-2"
          }
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(secondaryMembershipResponse.status).toBe(200);

    const sessionCookie = await createAuthenticatedCookie(env, "user_multi");

    const preSwitchResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session", {
        headers: {
          cookie: sessionCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(preSwitchResponse.status).toBe(200);
    expect((await preSwitchResponse.json()) as { activeWorkspaceId: string | null }).toMatchObject({
      activeWorkspaceId: null
    });

    const switchResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session/selection", {
        method: "POST",
        headers: {
          cookie: sessionCookie,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_2"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(switchResponse.status).toBe(200);
    expect(
      (await switchResponse.json()) as {
        activeOrganization: { organizationId: string };
        activeWorkspaceId: string | null;
        activeWorkspaceMembership: { workspaceId: string } | null;
        session: { activeWorkspaceId: string | null };
      }
    ).toMatchObject({
      activeOrganization: { organizationId: "org_2" },
      activeWorkspaceId: "ws_2",
      activeWorkspaceMembership: { workspaceId: "ws_2" },
      session: { activeWorkspaceId: "ws_2" }
    });

    const hydratedResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session", {
        headers: {
          cookie: sessionCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(hydratedResponse.status).toBe(200);
    expect(
      (await hydratedResponse.json()) as {
        activeOrganization: { organizationId: string } | null;
        activeWorkspaceId: string | null;
        activeWorkspaceMembership: { workspaceId: string } | null;
      }
    ).toMatchObject({
      activeOrganization: { organizationId: "org_2" },
      activeWorkspaceId: "ws_2",
      activeWorkspaceMembership: { workspaceId: "ws_2" }
    });
  });

  it("reports auth runtime readiness without exposing secret values", async () => {
    const { env } = createEnv();
    delete env.AUTH_ALLOWED_REDIRECT_ORIGINS;
    env.AUTH_SESSION_TTL_SECONDS = "invalid";

    const response = await handleFetch(
      new Request("https://example.test/readyz"),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(503);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      auth: {
        invalid: ["AUTH_SESSION_TTL_SECONDS"],
        missing: ["AUTH_ALLOWED_REDIRECT_ORIGINS"],
        ok: false
      },
      ok: false
    });
  });

  it("rejects unsafe absolute Google OAuth redirect targets in production config", async () => {
    const { env } = createEnv();

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fevil.example.test%2Fcloudtable"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("redirectTo is required");
  });

  it("allows configured absolute and relative Google OAuth redirect targets", async () => {
    const { env } = createEnv();

    const absoluteResponse = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fapp.example.test%2Fcloudtable"
      ),
      env,
      {} as ExecutionContext
    );
    expect(absoluteResponse.status).toBe(302);
    expect(new URL(absoluteResponse.headers.get("location") ?? "").searchParams.get("state")).toBeTruthy();

    const relativeResponse = await handleFetch(
      new Request("https://example.test/v1/auth/google/login?redirectTo=%2Fcloudtable%3Ftab%3Dhome"),
      env,
      {} as ExecutionContext
    );
    expect(relativeResponse.status).toBe(302);
    expect(new URL(relativeResponse.headers.get("location") ?? "").searchParams.get("state")).toBeTruthy();
  });

  it("bootstraps a first-time Google user into a new tenant only through explicit onboarding", async () => {
    const { env } = createEnv();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "founder@example.com",
            name: "Founder",
            sub: "google-oauth2|founder"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const rejectedLoginResponse = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fapp.example.test%2Fcloudtable"
      ),
      env,
      {} as ExecutionContext
    );
    const rejectedState = new URL(rejectedLoginResponse.headers.get("location") ?? "").searchParams.get("state");
    const rejectedCallbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(rejectedState ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(rejectedCallbackResponse.status).toBe(403);

    const loginResponse = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fapp.example.test%2Fcloudtable&onboarding=tenant_bootstrap&organizationName=Founder%20Org&workspaceName=Founder%20Workspace"
      ),
      env,
      {} as ExecutionContext
    );
    expect(loginResponse.status).toBe(302);
    const state = new URL(loginResponse.headers.get("location") ?? "").searchParams.get("state");
    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(302);
    const founderCookie = readCookieHeaderFromSetCookie(callbackResponse.headers.get("set-cookie") ?? "");

    const tenantResponse = await handleFetch(
      new Request("https://example.test/v1/tenants", {
        headers: {
          cookie: founderCookie
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(tenantResponse.status).toBe(200);
    expect(
      (await tenantResponse.json()) as {
        tenants: Array<{
          admin: boolean;
          organization: { name: string };
          workspace: { name: string };
        }>;
      }
    ).toMatchObject({
      tenants: [
        {
          admin: true,
          organization: { name: "Founder Org" },
          workspace: { name: "Founder Workspace" }
        }
      ]
    });
  });

  it("links a Google identity by email, establishes a session, and hydrates workspace ingress without principalId", async () => {
    const { db, env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_google_member",
      userId: "user_google_member"
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "user_google_member@example.com",
            name: "Google Member",
            sub: "google-oauth2|member"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const loginResponse = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fapp.example.test%2Fcloudtable&workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(loginResponse.status).toBe(302);
    const googleRedirect = new URL(loginResponse.headers.get("location") ?? "");
    expect(googleRedirect.origin).toBe("https://accounts.google.com");
    const state = googleRedirect.searchParams.get("state");
    expect(state).toBeTruthy();

    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("location")).toBe("https://app.example.test/cloudtable");
    const sessionCookie = callbackResponse.headers.get("set-cookie");
    expect(sessionCookie).toContain("cloudtable_session=");
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Secure");

    const cookieHeader = readCookieHeaderFromSetCookie(sessionCookie ?? "");
    const sessionResponse = await handleFetch(
      new Request("https://example.test/v1/auth/session?workspaceId=ws_1", {
        headers: {
          cookie: cookieHeader
        }
      }),
      env,
      {} as ExecutionContext
    );
    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      session: { userId: string };
      workspaceMembership: { principalId: string };
    };
    expect(sessionBody.session.userId).toBe("user_google_member");
    expect(sessionBody.workspaceMembership.principalId).toBe("usr_google_member");

    insertPermissionSnapshot(db, {
      snapshotId: "snap_google_catalog",
      workspaceId: "ws_1",
      principalId: "usr_google_member",
      policyRevision: 61,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const catalogResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/catalog?permissionScopeHash=scope:workspace&policyRevision=61",
        {
          headers: {
            cookie: cookieHeader
          }
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(catalogResponse.status).toBe(200);

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_google_member"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_google_command",
      workspaceId: "ws_1",
      principalId: "usr_google_member",
      policyRevision: 62,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["record.create"],
      fields: {
        fld_title: {
          agent: true,
          fieldId: "fld_title",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const commandResponse = await handleFetch(
      new Request("https://example.test/v1/commands/execute", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user"
          },
          commandId: "cmd_google_session_hydration",
          commandType: "record.create",
          idempotencyKey: "idem_google_session_hydration",
          payload: {
            recordId: "rec_google_session_hydration"
          },
          scope: "table",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(commandResponse.status).toBe(200);
    const commandBody = (await commandResponse.json()) as {
      command: { actor: { principalId: string } };
    };
    expect(commandBody.command.actor.principalId).toBe("usr_google_member");

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_google_accounts",
        "ws_1",
        "app_1",
        "google-accounts",
        "Google Accounts",
        0,
        1,
        "2026-06-10T00:00:00.000Z",
        "2026-06-10T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      config: {
        allowMultiple: false,
        targetTableId: "tbl_google_accounts"
      },
      fieldId: "fld_google_related_account",
      fieldKey: "google_related_account",
      fieldType: "relation.record",
      label: "Google Related Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_google_source_status",
      fieldKey: "google_source_status",
      fieldType: "text.single_line",
      label: "Google Source Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_google_target_status",
      fieldKey: "google_target_status",
      fieldType: "text.single_line",
      label: "Google Target Status",
      tableId: "tbl_google_accounts"
    });
    for (const field of [
      { fieldId: "fld_google_related_account", fieldType: "relation.record" },
      { fieldId: "fld_google_source_status", fieldType: "text.single_line" },
      { fieldId: "fld_google_target_status", fieldType: "text.single_line" }
    ]) {
      setFieldPrincipalPermission(db, {
        fieldId: field.fieldId,
        permission: {
          agent: true,
          read: "visible",
          workflow: true,
          write: true
        },
        principalId: "usr_google_member"
      });
    }
    insertPermissionSnapshot(db, {
      snapshotId: "snap_google_workflow_recipe",
      workspaceId: "ws_1",
      principalId: "usr_google_member",
      policyRevision: 63,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create", "workflow.publish"],
      fields: {
        fld_google_related_account: {
          agent: true,
          fieldId: "fld_google_related_account",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_google_source_status: {
          agent: true,
          fieldId: "fld_google_source_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_google_target_status: {
          agent: true,
          fieldId: "fld_google_target_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const recipePreviewResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes/preview", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Sync Google-authored status changes.",
          name: "Google session status sync",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 63,
          recipeType: "direct_sync",
          relatedSourceFieldId: "fld_google_related_account",
          syncSourceFieldId: "fld_google_source_status",
          syncTargetFieldId: "fld_google_target_status",
          workflowId: "wf_google_session_recipe_preview",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(recipePreviewResponse.status).toBe(200);
    const recipePreviewBody = (await recipePreviewResponse.json()) as {
      output: { command: { actor: { principalId: string } } };
    };
    expect(recipePreviewBody.output.command.actor.principalId).toBe("usr_google_member");

    const recipeCreateResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes", {
        method: "POST",
        headers: {
          cookie: cookieHeader,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Sync Google-authored status changes.",
          commandId: "cmd_google_session_recipe_create",
          idempotencyKey: "idem_google_session_recipe_create",
          name: "Google session status sync",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 63,
          publish: {
            commandId: "cmd_google_session_recipe_publish",
            idempotencyKey: "idem_google_session_recipe_publish"
          },
          recipeType: "direct_sync",
          relatedSourceFieldId: "fld_google_related_account",
          syncSourceFieldId: "fld_google_source_status",
          syncTargetFieldId: "fld_google_target_status",
          workflowId: "wf_google_session_recipe_create",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const recipeCreateBody = (await recipeCreateResponse.json()) as Record<string, unknown>;
    expect(recipeCreateResponse.status, JSON.stringify(recipeCreateBody)).toBe(200);
    expect(recipeCreateBody).toMatchObject({
      publish: {
        result: {
          accepted: true
        }
      },
      recipeType: "direct_sync",
      status: "published",
      workflowId: "wf_google_session_recipe_create"
    });
  });

  it("rejects Google callback linkage when the external identity belongs to a different canonical user", async () => {
    const { env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_alice",
      userId: "user_alice"
    });
    await provisionWorkspaceMembershipIdentity(env, {
      externalIdentity: {
        externalSubject: "google-oauth2|collision",
        id: "ext_google_collision",
        providerKey: "google"
      },
      principalId: "usr_bob",
      userId: "user_bob"
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "google-access-token" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        return new Response(
          JSON.stringify({
            email: "user_alice@example.com",
            name: "Alice",
            sub: "google-oauth2|collision"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      throw new Error(`Unexpected fetch to ${url}.`);
    });

    const loginResponse = await handleFetch(
      new Request(
        "https://example.test/v1/auth/google/login?redirectTo=https%3A%2F%2Fapp.example.test%2Fcloudtable"
      ),
      env,
      {} as ExecutionContext
    );
    const googleRedirect = new URL(loginResponse.headers.get("location") ?? "");
    const state = googleRedirect.searchParams.get("state");

    const callbackResponse = await handleFetch(
      new Request(
        `https://example.test/v1/auth/google/callback?code=google-code&state=${encodeURIComponent(state ?? "")}`
      ),
      env,
      {} as ExecutionContext
    );
    expect(callbackResponse.status).toBe(409);
    await expect(callbackResponse.text()).resolves.toContain("already linked to a different CloudTable user");
  });

  it("denies workspace catalog reads for non-members once membership foundation exists", async () => {
    const { db, env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_real_member",
      userId: "user_real_member"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workspace_catalog_non_member",
      workspaceId: "ws_1",
      principalId: "usr_non_member",
      policyRevision: 52,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/catalog?principalId=usr_non_member&permissionScopeHash=scope:workspace&policyRevision=52"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain(
      "Principal usr_non_member is not an active workspace member for ws_1."
    );
  });

  it("returns workflow operator manifests through the worker read ingress", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_operator_catalog_read",
      workspaceId: "ws_1",
      principalId: "ops_workflow_operator_catalog",
      policyRevision: 40,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/workflow-operators?principalId=ops_workflow_operator_catalog&permissionScopeHash=scope:workspace&policyRevision=40"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      workflowOperators: Array<Record<string, unknown>>;
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.workflowOperators.slice(0, 5).map((operator) => operator.id)).toEqual([
      "record_created",
      "record_updated",
      "field_changed",
      "scheduled",
      "manual"
    ]);
    expect(body.workflowOperators).toContainEqual({
      fixtureContract: [],
      id: "manual",
      idempotencyMode: "deterministic",
      inputSchema: {
        description: "Workflow trigger input envelope.",
        type: "object"
      },
      kind: "trigger",
      outputSchema: {
        description: "Normalized workflow trigger context.",
        type: "object"
      },
      purity: "pure",
      requiredCapabilities: ["workflows.execute"],
      retryClass: "none",
      timeoutClass: "fast",
      triggerEventTypes: ["workflow.manual"],
      version: 1
    });
    expect(body.workflowOperators).toContainEqual({
      fixtureContract: [
        {
          id: "equals.condition.sample",
          kind: "condition"
        }
      ],
      id: "equals",
      idempotencyMode: "deterministic",
      inputSchema: {
        description: "Inputs for equals.",
        type: "object"
      },
      kind: "condition",
      outputSchema: {
        description: "Boolean result for equals.",
        type: "boolean"
      },
      purity: "pure",
      requiredCapabilities: ["fields.read"],
      retryClass: "none",
      timeoutClass: "fast",
      version: 1
    });
    expect(body.workflowOperators).toContainEqual({
      commandScope: "workflow",
      commandType: "workflow.webhook.enqueue",
      fixtureContract: [
        {
          id: "send_webhook.action.sample",
          kind: "action"
        }
      ],
      id: "send_webhook",
      idempotencyMode: "command_idempotency_key",
      inputSchema: {
        description: "Inputs for send_webhook.",
        type: "object"
      },
      kind: "action",
      outputSchema: {
        description: "Command result emitted through the normal command bus.",
        type: "object"
      },
      proposalTemplate: {
        body: {
          event: "record.updated"
        },
        destination: "https://example.test/hooks/cloudtable"
      },
      purity: "impure",
      requiredCapabilities: ["webhooks.deliver"],
      retryClass: "network",
      timeoutClass: "network",
      version: 1
    });
    const sendWebhook = body.workflowOperators.find((operator) => operator.id === "send_webhook");
    expect(sendWebhook).toBeDefined();
    expect(sendWebhook).not.toHaveProperty("createCommand");
  });

  it("enqueues deterministic scheduled workflow dispatch payloads for due published workflows", async () => {
    const { db, env, workflowDispatchQueue } = createEnv();

    insertWorkflow(db, {
      definition: {
        workflowId: "wf_scheduled_due",
        metadata: {
          status: "published"
        },
        actions: [
          {
            operatorId: "emit_notification_event",
            input: {
              channel: "ops",
              message: "scheduled"
            }
          }
        ],
        conditions: [],
        principal: {
          principalId: "wf_scheduler"
        },
        trigger: {
          operatorId: "scheduled",
          match: {
            schedule: {
              cadenceMinutes: 5
            }
          }
        }
      },
      name: "Scheduled Due",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_scheduled_due",
      workflowKey: "scheduled-due"
    });

    insertWorkflow(db, {
      definition: {
        workflowId: "wf_scheduled_invalid",
        metadata: {
          status: "published"
        },
        actions: [
          {
            operatorId: "emit_notification_event",
            input: {
              channel: "ops",
              message: "invalid"
            }
          }
        ],
        conditions: [],
        trigger: {
          operatorId: "scheduled",
          match: {
            schedule: {
              cadenceMinutes: 0
            }
          }
        }
      },
      name: "Scheduled Invalid",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_scheduled_invalid",
      workflowKey: "scheduled-invalid"
    });

    await handleScheduled(
      createScheduledController(Date.parse("2026-06-06T00:10:00.000Z")),
      env,
      {} as ExecutionContext
    );

    expect(workflowDispatchQueue.sent).toEqual([
      {
        kind: "workflow-dispatch",
        payload: {
          cadenceMinutes: 5,
          scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
          scheduleWindowStart: "2026-06-06T00:05:00.000Z",
          scheduledAt: "2026-06-06T00:10:00.000Z",
          triggerKind: "scheduled",
          workflowId: "wf_scheduled_due",
          workflowVersionId: "wf_scheduled_due:v1"
        },
        workspaceId: "ws_1"
      }
    ]);
  });

  it("denies workflow operator manifest reads when the principal lacks workflow operator access", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_operator_catalog_denied",
      workspaceId: "ws_1",
      principalId: "usr_workflow_operator_catalog_denied",
      policyRevision: 41,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["record.create"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/workflow-operators?principalId=usr_workflow_operator_catalog_denied&permissionScopeHash=scope:workspace&policyRevision=41"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "forbidden"
    });
  });

  it("returns workflow recipe authoring metadata through the worker read ingress", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_recipe_catalog_read",
      workspaceId: "ws_1",
      principalId: "ops_workflow_recipe_catalog",
      policyRevision: 44,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/workflow-recipes?principalId=ops_workflow_recipe_catalog&permissionScopeHash=scope:workspace&policyRevision=44"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      catalog: {
        recipeTypes: string[];
        recipes: Record<string, Record<string, unknown>>;
      };
      permissionScope: {
        policyRevision: number;
        principalId: string;
        scopeHash: string;
        workspaceId: string;
      };
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.permissionScope).toEqual({
      policyRevision: 44,
      principalId: "ops_workflow_recipe_catalog",
      scopeHash: "scope:workspace",
      workspaceId: "ws_1"
    });
    expect(body.catalog.recipeTypes).toEqual(["direct_sync", "grouped_rollup"]);
    expect(body.catalog.recipes.direct_sync).toMatchObject({
      fixedTriggerId: "field_changed",
      maintenance: {
        kinds: ["backfill", "recompute"],
        queuedMessage: "Sync maintenance is queued after publish and runs asynchronously.",
        route: {
          method: "POST",
          pathTemplate: "/v1/workflows/{workflowId}/sync-maintenance"
        }
      },
      matchStrategies: ["single_relation", "value_match"],
      previewRoute: {
        method: "POST",
        pathTemplate: "/v1/tables/{tableId}/workflow-recipes/preview"
      },
      publishRoute: {
        method: "POST",
        pathTemplate: "/v1/workflows/{workflowId}/publish"
      },
      recipeType: "direct_sync",
      statusValues: ["draft", "published", "paused"]
    });
    expect(body.catalog.recipes.grouped_rollup).toMatchObject({
      aggregateOperations: [
        expect.objectContaining({ id: "count_records" }),
        expect.objectContaining({ id: "sum_numbers" }),
        expect.objectContaining({ id: "max_number" }),
        expect.objectContaining({ id: "min_number" }),
        expect.objectContaining({ id: "average_numbers" })
      ],
      fixedTriggerId: "field_changed",
      maintenance: {
        route: {
          method: "POST",
          pathTemplate: "/v1/workflows/{workflowId}/aggregate-maintenance"
        }
      },
      recipeType: "grouped_rollup"
    });
  });

  it("returns field type manifests through the worker read ingress", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_field_type_catalog_read",
      workspaceId: "ws_1",
      principalId: "ops_field_type_catalog",
      policyRevision: 42,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/field-types?principalId=ops_field_type_catalog&permissionScopeHash=scope:workspace&policyRevision=42"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fieldTypes: Array<Record<string, unknown>>;
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line"))
    );
    expect(body.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("status.semantic"))
    );
    expect(body.fieldTypes[0]).not.toHaveProperty("normalize");
  });

  it("returns agent tool manifests through the worker read ingress", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_tool_catalog_read",
      workspaceId: "ws_1",
      principalId: "ops_agent_tool_catalog",
      policyRevision: 43,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/agent-tools?principalId=ops_agent_tool_catalog&permissionScopeHash=scope:workspace&policyRevision=43"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agentTools: Array<Record<string, unknown>>;
      workspaceId: string;
    };

    expect(body.workspaceId).toBe("ws_1");
    expect(body.agentTools).toContainEqual(
      expect.objectContaining({
        binding: {
          kind: "query-service",
          service: "workspaceInspector"
        },
        id: "inspectWorkspace",
        mutating: false,
        mutationTarget: "none",
        phase: "draft",
        requiresConfirmation: false
      })
    );
    const inspectWorkspaceTool = body.agentTools.find((tool) => tool.id === "inspectWorkspace");
    expect(inspectWorkspaceTool).toBeDefined();
    expect(inspectWorkspaceTool).not.toHaveProperty("invoke");
  });

  it("supports include-filtered workspace catalog reads through the worker ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "published"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          }
        }
      },
      name: "Catalog Workflow",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_catalog",
      workflowKey: "catalog"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workspace_catalog_include",
      workspaceId: "ws_1",
      principalId: "ops_catalog_include",
      policyRevision: 33,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.pause"],
      fields: {}
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/workspaces/ws_1/catalog?principalId=ops_catalog_include&include=workflows&include=catalog&permissionScopeHash=scope:workspace&policyRevision=33"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      apps: unknown[];
      catalog?: {
        fieldTypes: Array<Record<string, unknown>>;
      };
      tables: unknown[];
      views: unknown[];
      workflows: Array<{
        name: string;
        status: string;
        tableId: string;
        workflowId: string;
      }>;
      workspaceId: string;
    };

    expect(body).toMatchObject({
      apps: [],
      tables: [],
      views: [],
      workflows: [
        {
          name: "Catalog Workflow",
          status: "published",
          tableId: "tbl_1",
          workflowId: "wf_catalog"
        }
      ],
      workspaceId: "ws_1"
    });
    expect(body.catalog?.fieldTypes).toContainEqual(
      serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line"))
    );
  });

  it("returns table schema metadata through the worker read ingress in deterministic field order", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        precision: 2
      },
      fieldId: "fld_beta",
      fieldKey: "estimate",
      fieldType: "number.decimal",
      label: "Estimate",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        required: true
      },
      fieldId: "fld_alpha",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_table_schema_read",
      workspaceId: "ws_1",
      principalId: "usr_table_schema",
      policyRevision: 34,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_alpha: {
          agent: true,
          fieldId: "fld_alpha",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_beta: {
          agent: true,
          fieldId: "fld_beta",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_table_schema&permissionScopeHash=scope:table:tbl_1&policyRevision=34"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      appId: string;
      fields: Array<{
        config: Record<string, unknown>;
        fieldId: string;
        fieldKey: string;
        fieldType: string;
        label: string;
      }>;
      schemaEpoch: number;
      tableId: string;
      tableName: string;
      tableSchemaVersion: number;
      tableSlug: string;
      workspaceId: string;
    };

    expect(body).toMatchObject({
      appId: "app_1",
      schemaEpoch: 0,
      tableId: "tbl_1",
      tableName: "Table 1",
      tableSchemaVersion: 1,
      tableSlug: "table-1",
      workspaceId: "ws_1"
    });
    expect(body.fields).toEqual([
      {
        config: {
          required: true
        },
        fieldId: "fld_alpha",
        fieldKey: "title",
        fieldType: "text.single_line",
        fieldTypeVersion: 1,
        label: "Title"
      },
      {
        config: {
          precision: 2
        },
        fieldId: "fld_beta",
        fieldKey: "estimate",
        fieldType: "number.decimal",
        fieldTypeVersion: 1,
        label: "Estimate"
      }
    ]);
  });

  it("returns first-class computed rollup field contracts through schema metadata ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        resultValueType: "number",
        rollup: {
          grouping: {
            sourceFieldId: "fld_account",
            strategy: "single_relation"
          },
          operandFieldId: "fld_amount",
          operationId: "sum_numbers",
          sourceTableId: "tbl_tickets"
        }
      },
      fieldId: "fld_rollup_revenue",
      fieldKey: "revenue_rollup",
      fieldType: "computed.readonly",
      label: "Revenue Rollup",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_table_schema_rollup_contract",
      workspaceId: "ws_1",
      principalId: "usr_table_schema_rollup_contract",
      policyRevision: 35,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_rollup_revenue: {
          agent: true,
          fieldId: "fld_rollup_revenue",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: true,
          write: false
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_table_schema_rollup_contract&permissionScopeHash=scope:table:tbl_1&policyRevision=35"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fields: Array<{
        config: Record<string, unknown>;
        fieldId: string;
      }>;
    };

    expect(body.fields).toContainEqual({
      config: {
        resultValueType: "number",
        rollup: {
          grouping: {
            sourceFieldId: "fld_account",
            strategy: "single_relation"
          },
          operandFieldId: "fld_amount",
          operationId: "sum_numbers",
          sourceTableId: "tbl_tickets"
        }
      },
      fieldId: "fld_rollup_revenue",
      fieldKey: "revenue_rollup",
      fieldType: "computed.readonly",
      fieldTypeVersion: 1,
      label: "Revenue Rollup"
    });
  });

  it("returns first-class computed lookup field contracts through schema metadata ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        lookup: {
          sourceFieldId: "fld_account",
          targetFieldId: "fld_account_name"
        }
      },
      fieldId: "fld_ticket_account_name",
      fieldKey: "ticket_account_name",
      fieldType: "computed.readonly",
      label: "Ticket Account Name",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_table_schema_lookup_contract",
      workspaceId: "ws_1",
      principalId: "usr_table_schema_lookup_contract",
      policyRevision: 36,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_ticket_account_name: {
          agent: true,
          fieldId: "fld_ticket_account_name",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: true,
          write: false
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_table_schema_lookup_contract&permissionScopeHash=scope:table:tbl_1&policyRevision=36"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fields: Array<{
        config: Record<string, unknown>;
        fieldId: string;
      }>;
    };

    expect(body.fields).toContainEqual({
      config: {
        lookup: {
          sourceFieldId: "fld_account",
          targetFieldId: "fld_account_name"
        }
      },
      fieldId: "fld_ticket_account_name",
      fieldKey: "ticket_account_name",
      fieldType: "computed.readonly",
      fieldTypeVersion: 1,
      label: "Ticket Account Name"
    });
  });

  it("surfaces field-declared canonical workflow aliases through schema and workspace inspection reads", async () => {
    const { db, env } = createEnv();
    const ownerField = createRowOwnerWorkflowBindingField();
    const assigneeField = createAssigneeAliasWorkflowBindingField();
    const statusField = createStatusWorkflowBindingField();
    const titleField = createTitleWorkflowBindingField();
    const expectedBindings = buildWorkflowBindingContract([
      ownerField,
      assigneeField,
      statusField,
      titleField
    ]).bindings;

    insertField(db, {
      config: ownerField.config,
      fieldId: ownerField.fieldId,
      fieldKey: ownerField.fieldKey,
      fieldType: ownerField.fieldType,
      label: "Owner",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: assigneeField.config,
      fieldId: assigneeField.fieldId,
      fieldKey: assigneeField.fieldKey,
      fieldType: assigneeField.fieldType,
      label: "Assignee",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: statusField.config,
      fieldId: statusField.fieldId,
      fieldKey: statusField.fieldKey,
      fieldType: statusField.fieldType,
      label: "Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: titleField.config,
      fieldId: titleField.fieldId,
      fieldKey: titleField.fieldKey,
      fieldType: titleField.fieldType,
      label: "Title",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_owner_metadata"
      },
      name: "Owner Metadata",
      publishedAt: "2026-06-06T00:00:00.000Z",
      workflowId: "wf_owner_metadata",
      workflowKey: "owner-metadata"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_owner_table_metadata",
      workspaceId: "ws_1",
      principalId: "usr_owner_metadata",
      policyRevision: 44,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.publish"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
          fieldType: "principal.user",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_assignee: {
          agent: true,
          fieldId: "fld_assignee",
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
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_owner_workspace_metadata",
      workspaceId: "ws_1",
      principalId: "ops_owner_metadata",
      policyRevision: 45,
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      commandTypes: ["workflow.publish"],
      fields: {}
    });

    const schemaResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_owner_metadata&permissionScopeHash=scope:table:tbl_1&policyRevision=44"
      ),
      env,
      {} as ExecutionContext
    );
    const schemaAgentResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            workspaceId: "ws_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 44,
          principalId: "usr_owner_metadata",
          toolId: "inspectTableSchema",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const workflowResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_owner_metadata/definition?workspaceId=ws_1&principalId=usr_owner_metadata&permissionScopeHash=scope:table:tbl_1&policyRevision=44"
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
          principalId: "ops_owner_metadata",
          toolId: "inspectWorkspace",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(schemaResponse.status).toBe(200);
    expect(schemaAgentResponse.status).toBe(200);
    expect(workflowResponse.status).toBe(200);
    expect(workspaceResponse.status).toBe(200);

    const schemaBody = (await schemaResponse.json()) as {
      view: {
        fields: Record<
          string,
          {
            capabilities: {
              supportsFiltering: boolean;
              supportsGrouping: boolean;
              supportsSorting: boolean;
            };
            fieldId: string;
            fieldKey: string;
            fieldType: string;
            supportedFilterOperatorIds: string[];
            supportedFilterOperators: Record<string, unknown>[];
            supportedSortModes: string[];
          }
        >;
        filterableFieldIds: string[];
        groupableFieldIds: string[];
        sortableFieldIds: string[];
      };
      workflow: {
        bindings: Record<string, Record<string, unknown>>;
      };
    };
    const schemaAgentBody = (await schemaAgentResponse.json()) as {
      output: {
        schema: {
          view: {
            fields: Record<
              string,
              {
                capabilities: {
                  supportsFiltering: boolean;
                  supportsGrouping: boolean;
                  supportsSorting: boolean;
                };
                fieldId: string;
                fieldKey: string;
                fieldType: string;
                supportedFilterOperatorIds: string[];
                supportedFilterOperators: Record<string, unknown>[];
                supportedSortModes: string[];
              }
            >;
          };
        };
      };
    };
    const workflowBody = (await workflowResponse.json()) as {
      workflow: {
        bindings: Record<string, Record<string, unknown>>;
      };
    };
    const workspaceBody = (await workspaceResponse.json()) as {
      output: {
        workspace: {
          tables: Array<{
            tableId: string;
            view: {
              fields: Record<
                string,
                {
                  capabilities: {
                    supportsFiltering: boolean;
                    supportsGrouping: boolean;
                    supportsSorting: boolean;
                  };
                  fieldId: string;
                  fieldKey: string;
                  fieldType: string;
                  supportedFilterOperatorIds: string[];
                  supportedFilterOperators: Record<string, unknown>[];
                  supportedSortModes: string[];
                }
              >;
            };
            workflow: {
              bindings: Record<string, Record<string, unknown>>;
            };
          }>;
        };
      };
    };

    expect(schemaBody.workflow.bindings["row.owner"]).toEqual(expectedBindings["row.owner"]);
    expect(schemaBody.workflow.bindings["row.assignee"]).toEqual(expectedBindings["row.assignee"]);
    expect(schemaBody.workflow.bindings["row.fields.owner"]).toEqual(expectedBindings["row.fields.owner"]);
    expect(schemaBody.workflow.bindings["row.fields.assignee"]).toEqual(expectedBindings["row.fields.assignee"]);
    expect(schemaBody.workflow.bindings["row.fields.status"]).toEqual(expectedBindings["row.fields.status"]);
    expect(schemaBody.workflow.bindings["row.fields.title"]).toEqual(expectedBindings["row.fields.title"]);
    expect(schemaBody.view.fields["fld_owner"]).toEqual({
      capabilities: {
        supportsFiltering: true,
        supportsGrouping: true,
        supportsSorting: true
      },
      fieldId: "fld_owner",
      fieldKey: "owner",
      fieldType: "principal.user",
      supportedFilterOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
      supportedFilterOperators: supportedConditionOperatorManifests([
        "equals",
        "not_equals",
        "is_empty",
        "is_not_empty"
      ]),
      supportedSortModes: ["ascending", "descending"]
    });
    expect(schemaBody.view.fields["fld_assignee"]).toEqual({
      ...schemaBody.view.fields["fld_owner"],
      fieldId: "fld_assignee",
      fieldKey: "assignee"
    });
    expect(schemaBody.view.filterableFieldIds).toEqual(
      expect.arrayContaining(["fld_owner", "fld_assignee", "fld_status", "fld_title"])
    );
    expect(schemaBody.view.groupableFieldIds).toEqual(
      expect.arrayContaining(["fld_owner", "fld_assignee", "fld_status", "fld_title"])
    );
    expect(schemaBody.view.sortableFieldIds).toEqual(
      expect.arrayContaining(["fld_owner", "fld_assignee", "fld_status", "fld_title"])
    );
    expect(schemaAgentBody.output.schema.view).toEqual(schemaBody.view);
    expect(workflowBody.workflow.bindings["row.owner"]).toEqual(expectedBindings["row.owner"]);
    expect(workflowBody.workflow.bindings["row.assignee"]).toEqual(expectedBindings["row.assignee"]);
    expect(workflowBody.workflow.bindings["row.fields.owner"]).toEqual(expectedBindings["row.fields.owner"]);
    expect(workflowBody.workflow.bindings["row.fields.assignee"]).toEqual(expectedBindings["row.fields.assignee"]);
    expect(workflowBody.workflow.bindings["row.fields.status"]).toEqual(expectedBindings["row.fields.status"]);
    expect(workflowBody.workflow.bindings["row.fields.title"]).toEqual(expectedBindings["row.fields.title"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.view
    ).toEqual(schemaBody.view);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings["row.owner"]
    ).toEqual(expectedBindings["row.owner"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings[
        "row.assignee"
      ]
    ).toEqual(expectedBindings["row.assignee"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings[
        "row.fields.owner"
      ]
    ).toEqual(expectedBindings["row.fields.owner"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings[
        "row.fields.assignee"
      ]
    ).toEqual(expectedBindings["row.fields.assignee"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings[
        "row.fields.status"
      ]
    ).toEqual(expectedBindings["row.fields.status"]);
    expect(
      workspaceBody.output.workspace.tables.find((table) => table.tableId === "tbl_1")?.workflow.bindings[
        "row.fields.title"
      ]
    ).toEqual(expectedBindings["row.fields.title"]);
  });

  it("drafts row.owner workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

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
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_owner_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_owner_workflow",
      policyRevision: 46,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
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
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "Notify sales ops when the owner is assigned.",
            fieldIds: ["fld_owner"],
            name: "Owner assigned follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_owner_assigned"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 46,
          principalId: "agt_owner_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
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
              },
              operatorId: "is_not_empty"
            }
          ]
        }
      }
    });
  });

  it("drafts field-declared canonical alias workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      config: {
        workflowBindingAlias: "row.assignee"
      },
      fieldId: "fld_assignee",
      fieldKey: "assignee",
      fieldType: "principal.user",
      label: "Assignee",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_assignee_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_assignee_workflow",
      policyRevision: 460,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_assignee: {
          agent: true,
          fieldId: "fld_assignee",
          fieldType: "principal.user",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "Notify sales ops when the assignee is assigned.",
            fieldIds: ["fld_assignee"],
            name: "Assignee assigned follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_assignee_assigned"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 460,
          principalId: "agt_assignee_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.assignee.fieldId"
                },
                fieldType: {
                  path: "row.assignee.fieldType"
                },
                value: {
                  path: "row.assignee.value"
                }
              },
              operatorId: "is_not_empty"
            }
          ]
        }
      }
    });
  });

  it("drafts canonical row.owner comparison workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_owner_workflow_comparison_proposal",
      workspaceId: "ws_1",
      principalId: "agt_owner_workflow_compare",
      policyRevision: 48,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
          fieldType: "principal.user",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "Notify sales ops when the owner is not assigned to the fallback user.",
            fieldIds: ["fld_owner"],
            name: "Owner differs from fallback",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_owner_not_fallback"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_owner_workflow_compare",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.owner.fieldId"
                },
                fieldType: {
                  path: "row.owner.fieldType"
                },
                value: {
                  path: "row.owner.value"
                },
                left: {
                  path: "row.owner.value"
                },
                right: null
              },
              operatorId: "not_equals"
            }
          ]
        }
      }
    });
  });

  it("drafts configured status workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();
    const statusField = createStatusWorkflowBindingField();

    insertField(db, {
      config: statusField.config,
      fieldId: statusField.fieldId,
      fieldKey: statusField.fieldKey,
      fieldType: statusField.fieldType,
      label: "Status",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_status_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_status_workflow",
      policyRevision: 47,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "When status changes to Qualified, notify sales ops.",
            fieldIds: ["fld_status"],
            name: "Qualified follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_status_qualified"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 47,
          principalId: "agt_status_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.fields.status.fieldId"
                },
                fieldType: {
                  path: "row.fields.status.fieldType"
                },
                value: {
                  path: "row.fields.status.value"
                },
                left: {
                  path: "row.fields.status.value"
                },
                right: "qualified"
              },
              operatorId: "equals"
            }
          ]
        }
      }
    });
  });

  it("drafts configured single-select workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();
    const stageField = createSingleSelectWorkflowBindingField();

    insertField(db, {
      config: stageField.config,
      fieldId: stageField.fieldId,
      fieldKey: stageField.fieldKey,
      fieldType: stageField.fieldType,
      label: "Lifecycle Stage",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_stage_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_stage_workflow",
      policyRevision: 49,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_stage: {
          agent: true,
          fieldId: "fld_stage",
          fieldType: "select.single",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "When lifecycle stage changes to Customer, notify sales ops.",
            fieldIds: ["fld_stage"],
            name: "Customer follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_stage_customer"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 49,
          principalId: "agt_stage_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.fields.lifecycle_stage.fieldId"
                },
                fieldType: {
                  path: "row.fields.lifecycle_stage.fieldType"
                },
                value: {
                  path: "row.fields.lifecycle_stage.value"
                },
                left: {
                  path: "row.fields.lifecycle_stage.value"
                },
                right: "customer"
              },
              operatorId: "equals"
            }
          ]
        }
      }
    });
  });

  it("drafts checkbox workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();
    const verifiedField = createCheckboxWorkflowBindingField();

    insertField(db, {
      config: verifiedField.config,
      fieldId: verifiedField.fieldId,
      fieldKey: verifiedField.fieldKey,
      fieldType: verifiedField.fieldType,
      label: "Is Verified",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_checkbox_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_checkbox_workflow",
      policyRevision: 470,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_verified: {
          agent: true,
          fieldId: "fld_verified",
          fieldType: "boolean.checkbox",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "Notify finance when is verified is unchecked.",
            fieldIds: ["fld_verified"],
            name: "Verification missing follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_verified_unchecked"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 470,
          principalId: "agt_checkbox_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.fields.is_verified.fieldId"
                },
                fieldType: {
                  path: "row.fields.is_verified.fieldType"
                },
                value: {
                  path: "row.fields.is_verified.value"
                },
                left: {
                  path: "row.fields.is_verified.value"
                },
                right: false
              },
              operatorId: "equals"
            }
          ]
        }
      }
    });
  });

  it("drafts relation contains-record workflow proposal conditions through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();
    const relationField = createRelationWorkflowBindingField();

    insertField(db, {
      config: relationField.config,
      fieldId: relationField.fieldId,
      fieldKey: relationField.fieldKey,
      fieldType: relationField.fieldType,
      label: "Related Companies",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_relation_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_relation_workflow",
      policyRevision: 471,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_related_companies: {
          agent: true,
          fieldId: "fld_related_companies",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "Notify sales ops when related companies includes the parent account.",
            fieldIds: ["fld_related_companies"],
            name: "Parent account follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_related_companies_parent"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 471,
          principalId: "agt_relation_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { output: { kind: string; proposal: { conditions: unknown[] } } }).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          conditions: [
            {
              input: {
                fieldId: {
                  path: "row.fields.related_companies.fieldId"
                },
                fieldType: {
                  path: "row.fields.related_companies.fieldType"
                },
                value: {
                  path: "row.fields.related_companies.value"
                },
                recordId: null
              },
              operatorId: "relation_contains_record"
            }
          ]
        }
      }
    });
  });

  it("drafts metadata-derived non-record action templates through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_webhook_workflow_proposal",
      workspaceId: "ws_1",
      principalId: "agt_webhook_workflow",
      policyRevision: 49,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["send_webhook"],
            businessRule: "When status changes, call the outbound workflow webhook.",
            fieldIds: ["fld_status"],
            name: "Webhook follow-up",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_webhook_follow_up"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 49,
          principalId: "agt_webhook_workflow",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect(
      (await response.json()) as {
        output: {
          command: {
            payload: {
              definition: {
                actions: unknown[];
              };
            };
          };
          kind: string;
          proposal: {
            actions: unknown[];
          };
        };
      }
    ).toMatchObject({
      output: {
        kind: "workflow-proposal",
        proposal: {
          actions: [
            {
              id: "send_webhook",
              proposalTemplate: {
                body: {
                  event: "record.updated"
                },
                destination: "https://example.test/hooks/cloudtable"
              }
            }
          ]
        },
        command: {
          payload: {
            definition: {
              actions: [
                {
                  input: {
                    body: {
                      event: "record.updated"
                    },
                    destination: "https://example.test/hooks/cloudtable"
                  },
                  operatorId: "send_webhook"
                }
              ]
            }
          }
        }
      }
    });
  });

  it("rejects table schema metadata reads when the permission snapshot hides fields", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret",
      fieldKey: "secret_notes",
      fieldType: "text.long",
      label: "Secret Notes",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_table_schema_denied",
      workspaceId: "ws_1",
      principalId: "usr_table_schema_denied",
      policyRevision: 35,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_secret: {
          agent: false,
          fieldId: "fld_secret",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_table_schema_denied&permissionScopeHash=scope:table:tbl_1&policyRevision=35"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { hiddenFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        hiddenFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("rejects inspectTableSchema agent tool reads when the permission snapshot hides fields", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret",
      fieldKey: "secret_notes",
      fieldType: "text.long",
      label: "Secret Notes",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_table_schema_denied",
      workspaceId: "ws_1",
      principalId: "agt_table_schema_denied",
      policyRevision: 40,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      fields: {
        fld_secret: {
          agent: false,
          fieldId: "fld_secret",
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
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 40,
          principalId: "agt_table_schema_denied",
          toolId: "inspectTableSchema",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { hiddenFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        hiddenFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("returns saved view definition metadata through the worker read ingress", async () => {
    const { db, env } = createEnv();

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
    insertField(db, {
      fieldId: "fld_priority",
      fieldKey: "priority",
      fieldType: "number.decimal",
      label: "Priority",
      tableId: "tbl_1"
    });
    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "in_progress"
        }
      ],
      groupByFieldId: "fld_priority",
      sorts: [
        {
          fieldId: "fld_priority",
          mode: "descending"
        },
        {
          fieldId: "fld_title",
          mode: "ascending"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_title", "fld_status", "fld_priority"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_view_definition_read",
      workspaceId: "ws_1",
      principalId: "usr_view_definition",
      policyRevision: 36,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_pipeline",
      fields: {
        fld_priority: {
          agent: true,
          fieldId: "fld_priority",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_pipeline/definition?workspaceId=ws_1&principalId=usr_view_definition&permissionScopeHash=scope:view:view_pipeline&policyRevision=36"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as {
      definition: {
        filterFieldIds: string[];
        filters: Array<{
          fieldId: string;
          operatorId: string;
          protected: boolean;
          value?: unknown;
        }>;
        groupByFieldId: string | null;
        sortFieldIds: string[];
        sorts: Array<{ fieldId: string; mode: string }>;
        visibleFieldIds: string[];
      };
      tableId: string;
      viewId: string;
      viewKey: string;
      viewName: string;
      viewSchemaVersion: number;
      workspaceId: string;
    }).toEqual({
      definition: {
        filterFieldIds: ["fld_status"],
        filters: [
          {
            fieldId: "fld_status",
            operatorId: "equals",
            protected: false,
            value: "in_progress"
          }
        ],
        groupByFieldId: "fld_priority",
        showEmptyGroups: false,
        sortFieldIds: ["fld_priority", "fld_title"],
        sorts: [
          {
            fieldId: "fld_priority",
            mode: "descending"
          },
          {
            fieldId: "fld_title",
            mode: "ascending"
          }
        ],
        visibleFieldIds: ["fld_title", "fld_status", "fld_priority"]
      },
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      viewSchemaVersion: 1,
      workspaceId: "ws_1"
    });
  });

  it("rejects saved view definition reads when the permission snapshot hides referenced fields", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret",
      fieldKey: "secret_score",
      fieldType: "number.decimal",
      label: "Secret Score",
      tableId: "tbl_1"
    });
    insertView(db, {
      groupByFieldId: "fld_secret",
      tableId: "tbl_1",
      viewId: "view_secret",
      viewKey: "secret",
      viewName: "Secret",
      visibleFieldIds: ["fld_title", "fld_secret"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_view_definition_denied",
      workspaceId: "ws_1",
      principalId: "usr_view_definition_denied",
      policyRevision: 37,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_secret",
      fields: {
        fld_secret: {
          agent: false,
          fieldId: "fld_secret",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_secret/definition?workspaceId=ws_1&principalId=usr_view_definition_denied&permissionScopeHash=scope:view:view_secret&policyRevision=37"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { hiddenFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        hiddenFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("rejects inspectViewDefinition agent tool reads when the permission snapshot hides referenced fields", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_secret",
      fieldKey: "secret_score",
      fieldType: "number.decimal",
      label: "Secret Score",
      tableId: "tbl_1"
    });
    insertView(db, {
      groupByFieldId: "fld_secret",
      tableId: "tbl_1",
      viewId: "view_secret",
      viewKey: "secret",
      viewName: "Secret",
      visibleFieldIds: ["fld_title", "fld_secret"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_view_definition_denied",
      workspaceId: "ws_1",
      principalId: "agt_view_definition_denied",
      policyRevision: 41,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_secret",
      fields: {
        fld_secret: {
          agent: false,
          fieldId: "fld_secret",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            viewId: "view_secret"
          },
          permissionScopeHash: "scope:view:view_secret",
          policyRevision: 41,
          principalId: "agt_view_definition_denied",
          toolId: "inspectViewDefinition",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    expect((await response.json()) as { details: { hiddenFieldIds: string[] }; error: string }).toMatchObject({
      details: {
        hiddenFieldIds: ["fld_secret"]
      },
      error: "forbidden"
    });
  });

  it("returns policy-protected saved filters and still enforces them from field indexes during view reads", async () => {
    const { db, env } = createEnv();

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

    insertRecordProjection(db, {
      fields: {
        title: "Visible active",
        status: ""
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        title: "Hidden inactive",
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_1",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_2",
      tableId: "tbl_1",
      textValue: "blocked"
    });
    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "active"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_protected_filter",
      viewKey: "protected-filter",
      viewName: "Protected Filter",
      visibleFieldIds: ["fld_title"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_protected_filter",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 38,
      schemaEpoch: 0,
      scopeHash: "scope:view:view_protected_filter",
      fields: {
        fld_status: {
          agent: false,
          fieldId: "fld_status",
          fieldType: "status.semantic",
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
      }
    });

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_protected_filter/definition?workspaceId=ws_1&principalId=usr_member&permissionScopeHash=scope:view:view_protected_filter&policyRevision=38"
      ),
      env,
      {} as ExecutionContext
    );

    expect(definitionResponse.status).toBe(200);
    expect((await definitionResponse.json()) as {
      definition: {
        filters: Array<{
          fieldId: string;
          operatorId: string;
          protected: boolean;
          value?: unknown;
        }>;
      };
    }).toMatchObject({
      definition: {
        filters: [
          {
            fieldId: "fld_status",
            operatorId: "equals",
            protected: true
          }
        ]
      }
    });

    const viewResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_protected_filter?workspaceId=ws_1&principalId=usr_member&permissionScopeHash=scope:view:view_protected_filter&policyRevision=38"
      ),
      env,
      {} as ExecutionContext
    );

    expect(viewResponse.status).toBe(200);
    expect((await viewResponse.json()) as {
      rows: Array<{ recordId: string; cells: Record<string, unknown> }>;
      view: {
        allowed: boolean;
        filters: Array<{ protected: boolean }>;
      };
    }).toMatchObject({
      rows: [
        {
          recordId: "rec_1",
          cells: {
            fld_title: "Visible active"
          }
        }
      ],
      view: {
        allowed: true,
        filters: [{ protected: true }]
      }
    });
  });

  it("routes app bootstrap inspection through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();
    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.publish"],
      fields: {},
      policyRevision: 46,
      principalId: "agt_app_bootstrap",
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      snapshotId: "snap_agent_app_bootstrap",
      workspaceId: "ws_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            appId: "app_1"
          },
          permissionScopeHash: "scope:workspace",
          policyRevision: 46,
          principalId: "agt_app_bootstrap",
          toolId: "inspectApp",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      output: {
        app: {
          appId: string;
          name: string;
          slug: string;
          tableCount: number;
        };
        kind: string;
      };
    };

    expect(body.output).toMatchObject({
      app: {
        appId: "app_1",
        name: "App 1",
        slug: "app-1",
        tableCount: 1
      },
      kind: "app-inspection"
    });
  });

  it("builds app and schema authoring drafts through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_schema_author"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["base.create", "table.create"],
      fields: {},
      policyRevision: 47,
      principalId: "agt_schema_author",
      schemaEpoch: 0,
      scopeHash: "scope:workspace",
      snapshotId: "snap_agent_schema_author_workspace",
      workspaceId: "ws_1"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["field.create", "field.permission.configure", "field.update", "field.archive"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      },
      policyRevision: 48,
      principalId: "agt_schema_author",
      schemaEpoch: 3,
      scopeHash: "scope:table:tbl_1",
      snapshotId: "snap_agent_schema_author_table",
      workspaceId: "ws_1"
    });

    const createAppResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            appId: "app_agent_preview",
            appName: "Agent Preview",
            appSlug: "agent-preview"
          },
          permissionScopeHash: "scope:workspace",
          policyRevision: 47,
          principalId: "agt_schema_author",
          toolId: "createApp",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const createTableResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            appId: "app_1",
            description: "Pipeline accounts",
            primaryField: {
              fieldId: "fld_primary_name",
              fieldType: "text.single_line",
              name: "Name",
              required: true
            },
            tableId: "tbl_agent_preview",
            tableName: "Agent Preview Accounts"
          },
          permissionScopeHash: "scope:workspace",
          policyRevision: 47,
          principalId: "agt_schema_author",
          toolId: "createTable",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const createFieldResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            config: {
              palette: "pipeline"
            },
            fieldId: "fld_pipeline_stage",
            fieldType: "status.semantic",
            name: "Pipeline Stage",
            required: true,
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_schema_author",
          toolId: "createField",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const configureFieldPermissionResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            agent: false,
            fieldId: "fld_status",
            principalId: "role_support",
            read: "redacted",
            tableId: "tbl_1",
            workflow: true,
            write: false
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_schema_author",
          toolId: "configureFieldPermission",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const updateFieldResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            config: {
              defaultColor: "green",
              display: "badge"
            },
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_schema_author",
          toolId: "updateField",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const archiveFieldResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_schema_author",
          toolId: "archiveField",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(createAppResponse.status).toBe(200);
    expect(createTableResponse.status).toBe(200);
    expect(createFieldResponse.status).toBe(200);
    expect(configureFieldPermissionResponse.status).toBe(200);
    expect(updateFieldResponse.status).toBe(200);
    expect(archiveFieldResponse.status).toBe(200);

    const createAppBody = (await createAppResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            baseId: string;
            name: string;
            slug: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    const createTableBody = (await createTableResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            appId: string;
            primaryField: {
              fieldId: string;
              fieldType: string;
              name: string;
              required: boolean;
            };
            tableId: string;
            tableName: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    const createFieldBody = (await createFieldResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            config: Record<string, unknown>;
            fieldId: string;
            fieldType: string;
            name: string;
            required: boolean;
            tableId: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    const configureFieldPermissionBody = (await configureFieldPermissionResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            fieldId: string;
            policy: {
              agent: boolean;
              read: string;
              workflow: boolean;
              write: boolean;
            };
            principalId: string;
            tableId: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    const updateFieldBody = (await updateFieldResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            config: Record<string, unknown>;
            fieldId: string;
            tableId: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };
    const archiveFieldBody = (await archiveFieldResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            fieldId: string;
            tableId: string;
          };
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      permissionScope: {
        policyRevision: number;
        scopeHash: string;
      };
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(createAppBody.tool).toEqual({
      id: "createApp",
      phase: "preview",
      scope: "app",
      successorToolId: "dryRunCommand"
    });
    expect(createAppBody.permissionScope).toMatchObject({
      policyRevision: 47,
      scopeHash: "scope:workspace"
    });
    expect(createAppBody.output).toMatchObject({
      command: {
        commandType: "base.create",
        payload: {
          baseId: "app_agent_preview",
          name: "Agent Preview",
          slug: "agent-preview"
        }
      },
      diffs: [
        {
          action: "propose",
          path: "/commands/base.create"
        }
      ],
      kind: "command-draft"
    });

    expect(createTableBody.tool).toEqual({
      id: "createTable",
      phase: "preview",
      scope: "table",
      successorToolId: "dryRunCommand"
    });
    expect(createTableBody.permissionScope).toMatchObject({
      policyRevision: 47,
      scopeHash: "scope:workspace"
    });
    expect(createTableBody.output).toMatchObject({
      command: {
        commandType: "table.create",
        payload: {
          appId: "app_1",
          primaryField: {
            fieldId: "fld_primary_name",
            fieldType: "text.single_line",
            name: "Name",
            required: true
          },
          tableId: "tbl_agent_preview",
          tableName: "Agent Preview Accounts"
        }
      },
      diffs: [
        {
          action: "create",
          path: "/apps/app_1/tables/tbl_agent_preview"
        },
        {
          action: "create",
          path: "/tables/tbl_agent_preview/fields/fld_primary_name"
        }
      ],
      kind: "command-draft"
    });

    expect(createFieldBody.tool).toEqual({
      id: "createField",
      phase: "preview",
      scope: "table",
      successorToolId: "dryRunCommand"
    });
    expect(createFieldBody.permissionScope).toMatchObject({
      policyRevision: 48,
      scopeHash: "scope:table:tbl_1"
    });
    expect(createFieldBody.output).toMatchObject({
      command: {
        commandType: "field.create",
        payload: {
          config: {
            palette: "pipeline"
          },
          fieldId: "fld_pipeline_stage",
          fieldType: "status.semantic",
          name: "Pipeline Stage",
          required: true,
          tableId: "tbl_1"
        }
      },
      diffs: [
        {
          action: "create",
          path: "/tables/tbl_1/fields/fld_pipeline_stage"
        }
      ],
      kind: "command-draft"
    });

    expect(configureFieldPermissionBody.tool).toEqual({
      id: "configureFieldPermission",
      phase: "preview",
      scope: "app",
      successorToolId: "dryRunCommand"
    });
    expect(configureFieldPermissionBody.permissionScope).toMatchObject({
      policyRevision: 48,
      scopeHash: "scope:table:tbl_1"
    });
    expect(configureFieldPermissionBody.output).toMatchObject({
      command: {
        commandType: "field.permission.configure",
        payload: {
          fieldId: "fld_status",
          policy: {
            agent: false,
            read: "redacted",
            workflow: true,
            write: false
          },
          principalId: "role_support",
          tableId: "tbl_1"
        }
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_1/fields/fld_status/permissions/role_support"
        }
      ],
      kind: "command-draft"
    });

    expect(updateFieldBody.tool).toEqual({
      id: "updateField",
      phase: "preview",
      scope: "app",
      successorToolId: "dryRunCommand"
    });
    expect(updateFieldBody.permissionScope).toMatchObject({
      policyRevision: 48,
      scopeHash: "scope:table:tbl_1"
    });
    expect(updateFieldBody.output).toMatchObject({
      command: {
        commandType: "field.update",
        payload: {
          config: {
            defaultColor: "green",
            display: "badge"
          },
          fieldId: "fld_status",
          tableId: "tbl_1"
        }
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_1/fields/fld_status"
        }
      ],
      kind: "command-draft"
    });

    expect(archiveFieldBody.tool).toEqual({
      id: "archiveField",
      phase: "preview",
      scope: "app",
      successorToolId: "dryRunCommand"
    });
    expect(archiveFieldBody.permissionScope).toMatchObject({
      policyRevision: 48,
      scopeHash: "scope:table:tbl_1"
    });
    expect(archiveFieldBody.output).toMatchObject({
      command: {
        commandType: "field.archive",
        payload: {
          fieldId: "fld_status",
          tableId: "tbl_1"
        }
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_1/fields/fld_status"
        }
      ],
      kind: "command-draft"
    });
  });

  it("dry-runs permission-sanitized agent commands through the worker ingress", async () => {
    const { db, env } = createEnv();

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
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_customer_note",
      permission: {
        agent: false,
        read: "hidden",
        workflow: false,
        write: false
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            command: {
              commandId: "cmd_dry_run_view",
              commandType: "view.create",
              idempotencyKey: "idem_dry_run_view",
              payload: {
                filterFieldIds: ["fld_customer_note"],
                sortFieldIds: ["fld_status"],
                viewId: "view_public",
                viewName: "Public Pipeline",
                visibleFieldIds: ["fld_title", "fld_customer_note", "fld_status"]
              },
              scope: "workspace",
              tableId: "tbl_1"
            }
          },
          principalId: "agt_assist",
          toolId: "dryRunCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      inputDiagnostics: string[];
      output: {
        command: {
          actor: { mode: string; principalId: string };
          payload: {
            filterFieldIds: string[];
            sortFieldIds: string[];
            viewId: string;
            viewName: string;
            visibleFieldIds: string[];
          };
          permissionScopeHash: string;
          permissionsVersion: number;
          workspaceId: string;
        };
        diffs: Array<{
          after: {
            filterFieldIds: string[];
            sortFieldIds: string[];
            viewId: string;
            viewName: string;
            visibleFieldIds: string[];
          };
        }>;
        kind: string;
        result: {
          diagnostics: string[];
          permission: { allowed: boolean };
          status: string;
        };
      };
      outputDiagnostics: string[];
      tool: {
        id: string;
        phase: string;
        scope: string;
        successorToolId: string | null;
      };
    };

    expect(body.tool).toEqual({
      id: "dryRunCommand",
      phase: "preview",
      scope: "app",
      successorToolId: "executeCommand"
    });
    expect(body.inputDiagnostics).toEqual(["agent_hidden:fld_customer_note"]);
    expect(body.output.kind).toBe("command-dry-run");
    expect(body.output.command.actor).toEqual({
      mode: "agent",
      principalId: "agt_assist"
    });
    expect(body.output.command).toMatchObject({
      permissionScopeHash: "scope:table:tbl_1",
      permissionsVersion: 0,
      workspaceId: "ws_1"
    });
    expect(body.output.command.payload).toEqual({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      viewId: "view_public",
      viewName: "Public Pipeline",
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.output.diffs[0]?.after).toMatchObject({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      viewId: "view_public",
      viewName: "Public Pipeline",
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.output.result).toMatchObject({
      diagnostics: ["dry_run"],
      permission: {
        allowed: true
      },
      status: "accepted"
    });
    expect(body.outputDiagnostics).toEqual([]);
  });

  it("builds explicit workflow lifecycle drafts through the agent-tool preview ingress", async () => {
    const { db, env } = createEnv();

    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        metadata: {
          status: "draft"
        },
        trigger: {
          match: {
            tableId: "tbl_1"
          },
          operatorId: "manual"
        },
        workflowId: "wf_agent_preview"
      },
      name: "Agent Preview",
      workflowId: "wf_agent_preview",
      workflowKey: "agent-preview"
    });

    const publishResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            workflowId: "wf_agent_preview"
          },
          principalId: "agt_assist",
          toolId: "publishWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const pauseResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            tableId: "tbl_1",
            workflowId: "wf_agent_preview"
          },
          principalId: "agt_assist",
          toolId: "pauseWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    const runResponse = await handleFetch(
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
            manualInvocationId: "manual_agent_preview_1",
            tableId: "tbl_1",
            workflowId: "wf_agent_preview"
          },
          principalId: "agt_assist",
          toolId: "runWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(publishResponse.status).toBe(200);
    expect(pauseResponse.status).toBe(200);
    expect(runResponse.status).toBe(200);

    const publishBody = (await publishResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            workflowId: string;
          };
          scope: string;
          tableId: string;
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      tool: {
        id: string;
        successorToolId: string | null;
      };
    };
    const pauseBody = (await pauseResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            workflowId: string;
          };
          scope: string;
          tableId: string;
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
    };
    const runBody = (await runResponse.json()) as {
      output: {
        command: {
          commandType: string;
          payload: {
            input: Record<string, unknown>;
            manualInvocationId: string;
            workflowId: string;
          };
          scope: string;
          tableId: string;
        };
        diffs: Array<{ action: string; path: string }>;
        kind: string;
      };
      tool: {
        id: string;
        successorToolId: string | null;
      };
    };

    expect(publishBody.tool).toMatchObject({
      id: "publishWorkflow",
      successorToolId: "dryRunCommand"
    });
    expect(publishBody.output).toMatchObject({
      command: {
        commandType: "workflow.publish",
        payload: {
          workflowId: "wf_agent_preview"
        },
        scope: "workflow",
        tableId: "tbl_1"
      },
      diffs: [
        {
          action: "update",
          path: "/workflows/wf_agent_preview"
        }
      ],
      kind: "command-draft"
    });
    expect(pauseBody.output).toMatchObject({
      command: {
        commandType: "workflow.pause",
        payload: {
          workflowId: "wf_agent_preview"
        },
        scope: "workflow",
        tableId: "tbl_1"
      },
      diffs: [
        {
          action: "update",
          path: "/workflows/wf_agent_preview"
        }
      ],
      kind: "command-draft"
    });
    expect(runBody.tool).toMatchObject({
      id: "runWorkflow",
      successorToolId: "dryRunCommand"
    });
    expect(runBody.output).toMatchObject({
      command: {
        commandType: "workflow.manual",
        payload: {
          input: {
            trigger: "button"
          },
          manualInvocationId: "manual_agent_preview_1",
          workflowId: "wf_agent_preview"
        },
        scope: "workflow",
        tableId: "tbl_1"
      },
      diffs: [
        {
          action: "create",
          path: "/workflows/wf_agent_preview/runs/manual"
        }
      ],
      kind: "command-draft"
    });
  });

  it("previews normalized commands through the worker ingress without committing or publishing", async () => {
    const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
      createEnv();

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
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user",
            principalId: "usr_member"
          },
          commandId: "cmd_preview_view",
          commandType: "view.create",
          idempotencyKey: "idem_preview_view",
          payload: {
            filterFieldIds: [],
            sortFieldIds: ["fld_status"],
            viewId: "view_preview",
            viewName: "Preview View",
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aggregate: { id: string; type: string } | null;
      command: {
        actor: { mode: string; principalId: string };
        permissionScopeHash: string;
        permissionsVersion: number;
        workspaceId: string;
      };
      result: {
        accepted: boolean;
        diagnostics: string[];
        events: unknown[];
        permission: { allowed: boolean };
        replayProjection: { receiptCount: number };
        sideEffects: unknown[];
        status: string;
      };
    };

    expect(body.aggregate).toEqual({
      id: "view_preview",
      type: "view"
    });
    expect(body.command.actor).toEqual({
      mode: "user",
      principalId: "usr_member"
    });
    expect(body.command).toMatchObject({
      permissionScopeHash: "scope:table:tbl_1",
      permissionsVersion: 0,
      workspaceId: "ws_1"
    });
    expect(body.result).toMatchObject({
      accepted: true,
      diagnostics: ["dry_run"],
      permission: {
        allowed: true
      },
      replayProjection: {
        receiptCount: 0
      },
      status: "accepted"
    });
    expect(body.result.events).toEqual([]);
    expect(body.result.sideEffects).toEqual([]);
    expect(
      db.inner
        .prepare("SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?")
        .get("cmd_preview_view")
    ).toEqual({
      count: 0
    });
    expect(eventFanoutQueue.sent).toEqual([]);
    expect(projectionQueue.sent).toEqual([]);
    expect(workflowDispatchQueue.sent).toEqual([]);
    expect(workflowStepQueue.sent).toEqual([]);
  });

  it("rejects stale explicit permission coordinates on the command preview ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user",
            principalId: "usr_member"
          },
          commandId: "cmd_preview_stale_scope",
          commandType: "view.create",
          idempotencyKey: "idem_preview_stale_scope",
          payload: {
            filterFieldIds: [],
            sortFieldIds: ["fld_status"],
            viewId: "view_preview_stale_scope",
            viewName: "Preview Stale Scope",
            visibleFieldIds: ["fld_status"]
          },
          permissionScopeHash: "scope:missing",
          permissionsVersion: 404,
          scope: "workspace",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Requested permissionScopeHash scope:missing does not match resolved scope scope:table:tbl_1."
    );
  });

  it("returns rejected dry-run results for invalid command payloads on the command preview ingress", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: false
      },
      principalId: "usr_limited"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user",
            principalId: "usr_limited"
          },
          commandId: "cmd_preview_invalid",
          commandType: "record.update",
          idempotencyKey: "idem_preview_invalid",
          payload: {
            patch: [],
            recordId: "rec_preview_invalid"
          },
          scope: "table",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        accepted: boolean;
        diagnostics: string[];
        events: unknown[];
        permission: { allowed: boolean; reasons: string[] };
        sideEffects: unknown[];
        status: string;
      };
    };

    expect(body.result.accepted).toBe(false);
    expect(body.result.status).toBe("rejected");
    expect(body.result.permission.allowed).toBe(false);
    expect(body.result.diagnostics).toContain("payload_patch_must_be_object");
    expect(body.result.events).toEqual([]);
    expect(body.result.sideEffects).toEqual([]);
    expect(
      db.inner
        .prepare("SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?")
        .get("cmd_preview_invalid")
    ).toEqual({
      count: 0
    });
    expect(eventFanoutQueue.sent).toEqual([]);
    expect(projectionQueue.sent).toEqual([]);
  });

  it("returns idempotent replay details on the command preview ingress after execution", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const executeBody = createRouteBody({
      actor: {
        mode: "user",
        principalId: "usr_member"
      },
      commandId: "cmd_preview_replay",
      idempotencyKey: "idem_preview_replay",
      payload: {
        filterFieldIds: [],
        sortFieldIds: ["fld_status"],
        viewId: "view_preview_replay",
        viewName: "Preview Replay",
        visibleFieldIds: ["fld_status"]
      }
    });

    const executeResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(executeBody)
      }),
      env,
      {} as ExecutionContext
    );

    expect(executeResponse.status).toBe(200);
    const publishedBeforePreview = {
      eventFanout: eventFanoutQueue.sent.length,
      projection: projectionQueue.sent.length
    };

    const previewResponse = await handleFetch(
      new Request("https://example.test/v1/commands/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user",
            principalId: "usr_member"
          },
          commandId: "cmd_preview_replay",
          commandType: "view.create",
          idempotencyKey: "idem_preview_replay",
          payload: {
            filterFieldIds: [],
            sortFieldIds: ["fld_status"],
            tableId: "tbl_1",
            viewId: "view_preview_replay",
            viewName: "Preview Replay",
            visibleFieldIds: ["fld_status"]
          },
          scope: "workspace",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(previewResponse.status).toBe(200);
    const previewBody = (await previewResponse.json()) as {
      result: {
        accepted: boolean;
        diagnostics: string[];
        events: Array<{ commandId: string }>;
        replayProjection: { acceptedCommandIds: string[]; receiptCount: number };
        sideEffects: unknown[];
        status: string;
      };
    };

    expect(previewBody.result).toMatchObject({
      accepted: true,
      diagnostics: ["idempotent_replay"],
      replayProjection: {
        receiptCount: 1
      },
      status: "accepted"
    });
    expect(previewBody.result.events[0]?.commandId).toBe("cmd_preview_replay");
    expect(previewBody.result.sideEffects.length).toBeGreaterThan(0);
    expect(eventFanoutQueue.sent.length).toBe(publishedBeforePreview.eventFanout);
    expect(projectionQueue.sent.length).toBe(publishedBeforePreview.projection);
    expect(
      db.inner
        .prepare("SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?")
        .get("cmd_preview_replay")
    ).toEqual({
      count: 1
    });
  });

  it("executes reviewed public commands through the explicit command execution ingress", async () => {
    const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
      createEnv();

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
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aggregate: { id: string; type: string } | null;
      command: {
        actor: { mode: string; principalId: string };
        permissionScopeHash: string;
        permissionsVersion: number;
        workspaceId: string;
      };
      result: {
        accepted: boolean;
        diagnostics: string[];
        events: Array<{ commandId: string; commandType: string; eventType: string }>;
        permission: { allowed: boolean };
        status: string;
      };
    };

    expect(body.aggregate).toEqual({
      id: "view_execute_public",
      type: "view"
    });
    expect(body.command).toMatchObject({
      actor: {
        mode: "user",
        principalId: "usr_member"
      },
      permissionScopeHash: "scope:table:tbl_1",
      permissionsVersion: 0,
      workspaceId: "ws_1"
    });
    expect(body.result).toMatchObject({
      accepted: true,
      diagnostics: [],
      permission: {
        allowed: true
      },
      status: "accepted"
    });
    expect(body.result.events).toHaveLength(1);
    expect(body.result.events[0]).toMatchObject({
      commandId: "cmd_execute_public_view",
      commandType: "view.create",
      eventType: "view.created"
    });
    expect(
      db.inner
        .prepare("SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?")
        .get("cmd_execute_public_view")
    ).toEqual({
      count: 1
    });
    expect(eventFanoutQueue.sent).toHaveLength(1);
    expect(projectionQueue.sent).toEqual([]);
    expect(workflowDispatchQueue.sent).toEqual([]);
    expect(workflowStepQueue.sent).toEqual([]);
  });

  it("denies explicit command execution for non-members once workspace membership foundation exists", async () => {
    const { db, env } = createEnv();

    await provisionWorkspaceMembershipIdentity(env, {
      principalId: "usr_member",
      userId: "user_member"
    });
    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_outsider"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/commands/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          actor: {
            mode: "user",
            principalId: "usr_outsider"
          },
          commandId: "cmd_execute_non_member",
          commandType: "record.create",
          idempotencyKey: "idem_execute_non_member",
          payload: {
            recordId: "rec_execute_non_member"
          },
          scope: "table",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain(
      "Principal usr_outsider is not an active workspace member for ws_1."
    );
  });

  it("returns rejected execution results for invalid command payloads on the explicit command execution ingress", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: false
      },
      principalId: "usr_limited"
    });

    const response = await handleFetch(
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        accepted: boolean;
        diagnostics: string[];
        events: unknown[];
        permission: { allowed: boolean; reasons: string[] };
        sideEffects: unknown[];
        status: string;
      };
    };

    expect(body.result.accepted).toBe(false);
    expect(body.result.status).toBe("rejected");
    expect(body.result.permission.allowed).toBe(false);
    expect(body.result.diagnostics).toContain("payload_patch_must_be_object");
    expect(body.result.events).toEqual([]);
    expect(body.result.sideEffects).toEqual([]);
    expect(
      db.inner
        .prepare("SELECT COUNT(*) AS count FROM event_ledger WHERE command_id = ?")
        .get("cmd_execute_invalid")
    ).toEqual({
      count: 0
    });
    expect(eventFanoutQueue.sent).toEqual([]);
    expect(projectionQueue.sent).toEqual([]);
  });

  it("rejects stale explicit permission coordinates on the explicit command execution ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
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
          commandId: "cmd_execute_stale_scope",
          commandType: "view.create",
          idempotencyKey: "idem_execute_stale_scope",
          payload: {
            filterFieldIds: [],
            sortFieldIds: ["fld_status"],
            viewId: "view_execute_stale_scope",
            viewName: "Execute Stale Scope",
            visibleFieldIds: ["fld_status"]
          },
          permissionScopeHash: "scope:missing",
          permissionsVersion: 404,
          scope: "workspace",
          tableId: "tbl_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Requested permissionScopeHash scope:missing does not match resolved scope scope:table:tbl_1."
    );
  });

  it("executes reviewed agent commands through the worker ingress with normalized context", async () => {
    const { db, env } = createEnv();

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
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_customer_note",
      permission: {
        agent: false,
        read: "hidden",
        workflow: false,
        write: false
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_title",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "agt_assist"
    });

    const response = await handleFetch(
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

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      inputDiagnostics: string[];
      output: {
        command: {
          actor: { mode: string; principalId: string };
          payload: {
            filterFieldIds: string[];
            sortFieldIds: string[];
            viewId: string;
            viewName: string;
            visibleFieldIds: string[];
          };
          permissionScopeHash: string;
          permissionsVersion: number;
          schemaEpoch: number;
          workspaceId: string;
        };
        kind: string;
        result: {
          accepted: boolean;
          events: Array<{ commandId: string; commandType: string; eventType: string }>;
          status: string;
        };
      };
      tool: {
        id: string;
        phase: string;
      };
    };

    expect(body.tool).toMatchObject({
      id: "executeCommand",
      phase: "execute"
    });
    expect(body.inputDiagnostics).toEqual(["agent_hidden:fld_customer_note"]);
    expect(body.output.kind).toBe("command-execution");
    expect(body.output.command).toMatchObject({
      actor: {
        mode: "agent",
        principalId: "agt_assist"
      },
      permissionScopeHash: "scope:table:tbl_1",
      permissionsVersion: 0,
      schemaEpoch: 0,
      workspaceId: "ws_1"
    });
    expect(body.output.command.payload).toEqual({
      filterFieldIds: [],
      sortFieldIds: ["fld_status"],
      viewId: "view_public",
      viewName: "Public Pipeline",
      visibleFieldIds: ["fld_title", "fld_status"]
    });
    expect(body.output.result).toMatchObject({
      accepted: true,
      events: [
        {
          commandId: "cmd_execute_view",
          commandType: "view.create",
          eventType: "view.created"
        }
      ],
      status: "accepted"
    });
  });

  it("executes a named workflow manual wrapper through the audited agent-tool execute ingress", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        status: null
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertWorkflow(db, {
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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_execute_manual",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 41,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.manual"],
      fields: {}
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_execute_workflow",
      workspaceId: "ws_1",
      principalId: "wf_service",
      policyRevision: 7,
      schemaEpoch: 0,
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

    const preview = await handleFetch(
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
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as {
      output: {
        command: CommandEnvelope;
      };
    };

    const execute = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            command: previewBody.output.command
          },
          principalId: "agt_assist",
          toolId: "executeCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(execute.status).toBe(200);
    const body = (await execute.json()) as {
      output: {
        command: {
          actor: { mode: string; principalId: string };
          commandId: string;
          commandType: string;
          idempotencyKey: string;
          payload: {
            input: Record<string, unknown>;
            manualInvocationId: string;
            workflowId: string;
          };
        };
        kind: string;
        result: {
          accepted: boolean;
          events: Array<{ commandType: string; eventType: string }>;
          status: string;
        };
      };
    };

    expect(body.output.kind).toBe("command-execution");
    expect(body.output.command).toMatchObject({
      actor: {
        mode: "agent",
        principalId: "agt_assist"
      },
      commandType: "workflow.manual",
      payload: {
        input: {
          trigger: "button"
        },
        manualInvocationId: "manual_agent_execute_1",
        workflowId: "wf_agent_execute"
      }
    });
    expect(body.output.command.commandId).toEqual(expect.stringMatching(/^cmd_workflow_manual_/));
    expect(body.output.command.idempotencyKey).toEqual(
      expect.stringMatching(/^idem_workflow_manual_/)
    );
    expect(body.output.result).toMatchObject({
      accepted: true,
      events: [
        {
          commandType: "workflow.manual",
          eventType: "workflow.manual"
        }
      ],
      status: "accepted"
    });
    expect(eventFanoutQueue.sent).toHaveLength(1);
    expect(workflowDispatchQueue.sent).toEqual([]);
  });

  it("creates a generic field workflow through the audited agent-tool execute ingress", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

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
    insertPermissionSnapshot(db, {
      snapshotId: "snap_status_workflow_execute",
      workspaceId: "ws_1",
      principalId: "agt_status_workflow_execute",
      policyRevision: 48,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create", "workflow.publish"],
      fields: {
        fld_status: {
          agent: true,
          fieldId: "fld_status",
          fieldType: "status.semantic",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const previewResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            actionIds: ["update_record"],
            businessRule: "When status changes to Qualified, notify sales ops.",
            fieldIds: ["fld_status"],
            name: "Qualified execute",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_status_qualified_execute"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 48,
          principalId: "agt_status_workflow_execute",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(previewResponse.status).toBe(200);
    const previewBody = (await previewResponse.json()) as {
      output: {
        command: CommandEnvelope;
        proposal: {
          conditions: Array<{
            input: {
              fieldId: {
                path: string;
              };
              fieldType: {
                path: string;
              };
              value: {
                path: string;
              };
            };
            operatorId: string;
          }>;
        };
      };
    };
    expect(previewBody.output.proposal.conditions).toEqual([
      {
        input: {
          fieldId: {
            path: "row.fields.status.fieldId"
          },
          fieldType: {
            path: "row.fields.status.fieldType"
          },
          value: {
            path: "row.fields.status.value"
          },
          left: {
            path: "row.fields.status.value"
          },
          right: "qualified"
        },
        operatorId: "equals"
      }
    ]);

    const executeResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            command: previewBody.output.command
          },
          principalId: "agt_status_workflow_execute",
          toolId: "executeCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(executeResponse.status).toBe(200);
    const executeBody = (await executeResponse.json()) as {
      inputDiagnostics: string[];
      output: {
        command: CommandEnvelope;
        kind: string;
        result: {
          accepted: boolean;
          events: Array<{ commandType: string; eventType: string }>;
          status: string;
        };
      };
      tool: {
        id: string;
        phase: string;
      };
    };

    expect(executeBody.tool).toMatchObject({
      id: "executeCommand",
      phase: "execute"
    });
    expect(executeBody.inputDiagnostics).toEqual([]);
    expect(executeBody.output.kind).toBe("command-execution");
    expect(executeBody.output.command).toMatchObject({
      actor: {
        mode: "agent",
        principalId: "agt_status_workflow_execute"
      },
      commandType: "workflow.create",
      permissionScopeHash: "scope:table:tbl_1",
      permissionsVersion: 48,
      schemaEpoch: 0,
      workspaceId: "ws_1"
    });
    expect(executeBody.output.command.payload).toMatchObject({
      definition: {
        conditions: [
          {
            input: {
              fieldId: {
                path: "row.fields.status.fieldId"
              },
              fieldType: {
                path: "row.fields.status.fieldType"
              },
              value: {
                path: "row.fields.status.value"
              },
              left: {
                path: "row.fields.status.value"
              },
              right: "qualified"
            },
            operatorId: "equals"
          }
        ],
        workflowId: "wf_status_qualified_execute"
      },
      workflowId: "wf_status_qualified_execute",
      workflowKey: "status-qualified-execute"
    });
    expect(executeBody.output.result).toMatchObject({
      accepted: true,
      events: [
        {
          commandType: "workflow.create",
          eventType: "workflow.created"
        }
      ],
      status: "accepted"
    });
    expect(eventFanoutQueue.sent).toHaveLength(1);

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_status_qualified_execute/definition?workspaceId=ws_1&principalId=agt_status_workflow_execute&permissionScopeHash=scope:table:tbl_1&policyRevision=48"
      ),
      env,
      {} as ExecutionContext
    );

    expect(definitionResponse.status).toBe(200);
    expect((await definitionResponse.json()) as Record<string, unknown>).toMatchObject({
      definition: {
        conditions: [
          {
            input: {
              fieldId: {
                path: "row.fields.status.fieldId"
              },
              fieldType: {
                path: "row.fields.status.fieldType"
              },
              value: {
                path: "row.fields.status.value"
              },
              left: {
                path: "row.fields.status.value"
              },
              right: "qualified"
            },
            operatorId: "equals"
          }
        ]
      },
      workflow: {
        bindings: {
          "row.fields.status": {
            binding: "row.fields.status",
            fieldId: "fld_status",
            fieldKey: "status",
            fieldType: "status.semantic",
            template: {
              fieldIdPath: "row.fields.status.fieldId",
              fieldTypePath: "row.fields.status.fieldType",
              valuePath: "row.fields.status.value"
            }
          }
        }
      },
      workflowId: "wf_status_qualified_execute",
      workflowKey: "status-qualified-execute",
      workflowName: "Qualified execute"
    });
  });

  it("drafts, executes, publishes, and reads back reactive rollup workflow proposals through ingress", async () => {
    const { aggregateQueue, db, env, eventFanoutQueue } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );

    insertField(db, {
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      },
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        dependsOnFieldIds: ["fld_ticket_account", "fld_ticket_amount"],
        resultValueType: "number",
        rollup: {
          grouping: {
            sourceFieldId: "fld_ticket_account",
            strategy: "single_relation"
          },
          operandFieldId: "fld_ticket_amount",
          operationId: "sum_numbers",
          sourceTableId: "tbl_1"
        }
      },
      fieldId: "fld_account_revenue_rollup",
      fieldKey: "revenue_sum",
      fieldType: "computed.readonly",
      label: "Revenue Sum",
      tableId: "tbl_accounts"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_rollup_workflow_execute",
      workspaceId: "ws_1",
      principalId: "agt_rollup_workflow_execute",
      policyRevision: 52,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create", "workflow.publish"],
      fields: {
        fld_ticket_account: {
          agent: true,
          fieldId: "fld_ticket_account",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_ticket_amount: {
          agent: true,
          fieldId: "fld_ticket_amount",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_account_revenue_rollup: {
          agent: true,
          fieldId: "fld_account_revenue_rollup",
          fieldType: "computed.readonly",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const previewResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Roll ticket amount into account revenue.",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 52,
          principalId: "agt_rollup_workflow_execute",
          name: "Ticket revenue rollup",
          recipeType: "grouped_rollup",
          rollupFieldIds: ["fld_account_revenue_rollup"],
          workflowId: "wf_ticket_revenue_rollup_execute",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(previewResponse.status).toBe(200);

    const previewBody = (await previewResponse.json()) as {
      output: {
        command: CommandEnvelope;
        proposal: {
          metadata: Record<string, unknown>;
        };
      };
    };
    expect(previewBody.output.proposal.metadata).toMatchObject({
      aggregateDefinitions: [
        {
          alias: "fld_account_revenue_rollup",
          groupingSource: {
            kind: "related_record",
            resolverAlias: "rollup_fld_account_revenue_rollup"
          },
          operationId: "sum_numbers",
          sourceRelationPath: "relatedTables.rollup_fld_account_revenue_rollup",
          targetFieldId: "fld_account_revenue_rollup"
        }
      ],
      relatedTableResolvers: [
        {
          alias: "rollup_fld_account_revenue_rollup",
          sourceFieldId: "fld_ticket_account",
          strategy: "single_relation",
          targetTableId: "tbl_accounts"
        }
      ],
      rollupFieldIds: ["fld_account_revenue_rollup"]
    });
    expect(previewBody.output.command.payload).toMatchObject({
      definition: {
        actions: [
          {
            input: {
              fieldId: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.row.fields.revenue_sum.fieldId"
              },
              fieldType: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.row.fields.revenue_sum.fieldType"
              },
              recordId: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.row.recordId"
              },
              tableId: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.tableId"
              },
              value: {
                path: "cell.value"
              }
            },
            operatorId: "set_cell"
          }
        ],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "fld_account_revenue_rollup",
              operationId: "sum_numbers",
              targetFieldId: "fld_account_revenue_rollup"
            }
          ]
        },
        trigger: {
          match: {
            fieldIds: ["fld_ticket_account", "fld_ticket_amount"],
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        }
      }
    });

    const createResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Roll ticket amount into account revenue.",
          commandId: "cmd_create_rollup_workflow_recipe",
          idempotencyKey: "idem_create_rollup_workflow_recipe",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 52,
          principalId: "agt_rollup_workflow_execute",
          name: "Ticket revenue rollup",
          publish: true,
          publishCommandId: "cmd_publish_rollup_workflow_recipe",
          publishIdempotencyKey: "idem_publish_rollup_workflow_recipe",
          recipeType: "grouped_rollup",
          rollupFieldIds: ["fld_account_revenue_rollup"],
          workflowId: "wf_ticket_revenue_rollup_execute",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(createResponse.status).toBe(200);
    expect((await createResponse.json()) as Record<string, unknown>).toMatchObject({
      create: {
        result: {
          accepted: true
        }
      },
      publish: {
        result: {
          accepted: true
        }
      },
      recipeType: "grouped_rollup",
      status: "published",
      workflowId: "wf_ticket_revenue_rollup_execute"
    });

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never,
      env,
      {} as ExecutionContext
    );
    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "fld_account_revenue_rollup",
          operationId: "sum_numbers",
          targetFieldId: "fld_account_revenue_rollup"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_ticket_revenue_rollup_execute"
      },
      workspaceId: "ws_1"
    });

    const dependencyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_ticket_revenue_rollup_execute/dependencies?workspaceId=ws_1&principalId=agt_rollup_workflow_execute&permissionScopeHash=scope:table:tbl_1&policyRevision=52"
      ),
      env,
      {} as ExecutionContext
    );
    expect(dependencyResponse.status).toBe(200);
    const dependencyBody = (await dependencyResponse.json()) as {
      backfillJobs: Array<{
        dependencyAlias: string;
        dependencyKind: string;
        reason: string;
        status: string;
      }>;
      dependencies: Array<{
        alias: string;
        dependencyFieldIds: string[];
        kind: string;
        sourceTableId: string | null;
        status: string;
        targetTableId: string | null;
      }>;
      summary: {
        attentionRequiredBackfillJobs: unknown[];
        backfillJobsByStatus: Record<string, number>;
        completedBackfillJobCount: number;
        dependenciesByKind: Record<string, number>;
        dependenciesByStatus: Record<string, number>;
        failedBackfillJobCount: number;
        maintenanceState: string;
        pendingBackfillJobCount: number;
        resumableBackfillJobCount: number;
        runningBackfillJobCount: number;
        totalBackfillProcessedCount: number;
        totalBackfillJobCount: number;
      };
    };
    expect(dependencyBody.dependencies).toContainEqual(
      expect.objectContaining({
        alias: "fld_account_revenue_rollup",
        dependencyFieldIds: ["fld_ticket_account", "fld_ticket_amount"],
        kind: "aggregate",
        sourceTableId: "tbl_1",
        status: "published",
        targetTableId: "tbl_accounts"
      })
    );
    expect(dependencyBody.backfillJobs).toContainEqual(
      expect.objectContaining({
        dependencyAlias: "fld_account_revenue_rollup",
        dependencyKind: "aggregate",
        reason: "workflow_published",
        status: "queued"
      })
    );
    expect(dependencyBody.summary).toMatchObject({
      attentionRequiredBackfillJobs: [],
      backfillJobsByStatus: {
        queued: 1
      },
      completedBackfillJobCount: 0,
      dependenciesByKind: expect.objectContaining({
        aggregate: 1
      }),
      dependenciesByStatus: expect.objectContaining({
        published: expect.any(Number)
      }),
      failedBackfillJobCount: 0,
      maintenanceState: "active",
      pendingBackfillJobCount: 1,
      resumableBackfillJobCount: 0,
      runningBackfillJobCount: 0,
      totalBackfillProcessedCount: 0,
      totalBackfillJobCount: 1
    });

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_ticket_revenue_rollup_execute/definition?workspaceId=ws_1&principalId=agt_rollup_workflow_execute&permissionScopeHash=scope:table:tbl_1&policyRevision=52"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionResponse.status).toBe(200);
    expect((await definitionResponse.json()) as Record<string, unknown>).toMatchObject({
      definition: {
        actions: [
          {
            input: {
              fieldId: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.row.fields.revenue_sum.fieldId"
              },
              fieldType: {
                path: "relatedTables.rollup_fld_account_revenue_rollup.row.fields.revenue_sum.fieldType"
              }
            },
            operatorId: "set_cell"
          }
        ],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "fld_account_revenue_rollup",
              groupingSource: {
                kind: "related_record",
                resolverAlias: "rollup_fld_account_revenue_rollup"
              },
              operationId: "sum_numbers",
              sourceRelationPath: "relatedTables.rollup_fld_account_revenue_rollup",
              targetFieldId: "fld_account_revenue_rollup"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "rollup_fld_account_revenue_rollup",
              sourceFieldId: "fld_ticket_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          rollupFieldIds: ["fld_account_revenue_rollup"]
        }
      },
      workflowId: "wf_ticket_revenue_rollup_execute",
      workflowKey: "ticket-revenue-rollup-execute",
      workflowName: "Ticket revenue rollup"
    });
  });

  it("previews selected-record reactive rollup workflows through direct and agent-tool ingress with workflow-step diagnostics", async () => {
    const { db, env } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );

    insertField(db, {
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      },
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_revenue_sum",
      fieldKey: "revenue_sum",
      fieldType: "number.decimal",
      label: "Revenue Sum",
      tableId: "tbl_accounts"
    });
    insertRecordProjection(db, {
      fields: {
        revenue_sum: 0
      },
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_revenue_sum",
      fieldKey: "revenue_sum",
      fieldType: "number.decimal",
      recordId: "rec_account_1",
      tableId: "tbl_accounts",
      value: 0
    });
    insertRecordProjection(db, {
      fields: {
        account: ["rec_account_1"],
        amount: 35
      },
      recordId: "rec_ticket_1",
      recordKey: "ticket-1",
      tableId: "tbl_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: ["rec_account_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 35
    });
    insertWorkflow(db, {
      definition: {
        actions: [
          {
            input: {
              fieldId: {
                path: "relatedTables.rollup_fld_revenue_sum.row.fields.revenue_sum.fieldId"
              },
              fieldType: {
                path: "relatedTables.rollup_fld_revenue_sum.row.fields.revenue_sum.fieldType"
              },
              recordId: {
                path: "relatedTables.rollup_fld_revenue_sum.row.recordId"
              },
              tableId: {
                path: "relatedTables.rollup_fld_revenue_sum.tableId"
              },
              value: {
                path: "cell.value"
              }
            },
            operatorId: "set_cell"
          }
        ],
        conditions: [],
        metadata: {
          aggregateDefinitions: [
            {
              alias: "fld_revenue_sum",
              groupingSource: {
                kind: "related_record",
                resolverAlias: "rollup_fld_revenue_sum"
              },
              operationId: "sum_numbers",
              sourceRelationPath: "relatedTables.rollup_fld_revenue_sum",
              targetFieldId: "fld_revenue_sum"
            }
          ],
          relatedTableResolvers: [
            {
              alias: "rollup_fld_revenue_sum",
              sourceFieldId: "fld_ticket_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ],
          status: "draft",
          tableId: "tbl_1"
        },
        principal: {
          policyRevision: 52,
          principalId: "wf_rollup_preview",
          schemaEpoch: 0,
          scopeHash: "scope:table:tbl_1"
        },
        trigger: {
          match: {
            fieldIds: ["fld_ticket_account", "fld_ticket_amount"],
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_rollup_preview"
      },
      name: "Rollup Preview",
      workflowId: "wf_rollup_preview",
      workflowKey: "rollup-preview"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_workflow_rollup_preview",
      workspaceId: "ws_1",
      principalId: "wf_rollup_preview",
      policyRevision: 52,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["cell.set"],
      fields: {
        fld_ticket_account: {
          agent: false,
          fieldId: "fld_ticket_account",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_ticket_amount: {
          agent: false,
          fieldId: "fld_ticket_amount",
          fieldType: "number.decimal",
          read: "redacted",
          workflow: true,
          write: true
        },
        fld_revenue_sum: {
          agent: false,
          fieldId: "fld_revenue_sum",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_user_workflow_rollup_preview",
      workspaceId: "ws_1",
      principalId: "usr_workflow_preview",
      policyRevision: 18,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.manual"],
      fields: {
        fld_ticket_account: {
          agent: true,
          fieldId: "fld_ticket_account",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: false
        },
        fld_ticket_amount: {
          agent: true,
          fieldId: "fld_ticket_amount",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: false
        }
      }
    });

    const directResponse = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_rollup_preview/test-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 18,
          principalId: "usr_workflow_preview",
          recordId: "rec_ticket_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(directResponse.status).toBe(200);
    const directBody = (await directResponse.json()) as {
      actions: Array<{
        diagnostics: string[];
        plan: {
          aggregateAlias: string | null;
          kind: string;
        };
        result: {
          accepted: boolean;
          diagnostics: string[];
        };
        wouldRun: boolean;
      }>;
      diagnostics: string[];
      scope: {
        row: {
          redactedFieldIds: string[];
        };
      };
      status: string;
      trigger: {
        matched: boolean;
        selectedFieldId: string | null;
      };
      workflowVersionId: string;
    };
    expect(directBody.status).toBe("ready");
    expect(directBody.trigger).toMatchObject({
      matched: true,
      selectedFieldId: "fld_ticket_account"
    });
    expect(directBody.scope.row.redactedFieldIds).toEqual(["fld_ticket_amount"]);
    expect(directBody.diagnostics).toContain("workflow_redacted:fld_ticket_amount");
    expect(directBody.actions[0]).toMatchObject({
      diagnostics: ["dry_run"],
      plan: {
        aggregateAlias: "fld_revenue_sum",
        kind: "reactive_rollup"
      },
      result: {
        accepted: true,
        diagnostics: ["dry_run"]
      },
      wouldRun: true
    });

    const toolResponse = await handleFetch(
      new Request("https://example.test/v1/agent-tools/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            recordId: "rec_ticket_1",
            workflowId: "wf_rollup_preview"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 18,
          principalId: "usr_workflow_preview",
          toolId: "previewWorkflowTest",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(toolResponse.status).toBe(200);
    const toolBody = (await toolResponse.json()) as {
      output: {
        kind: string;
        preview: Record<string, unknown>;
      };
      tool: {
        id: string;
        phase: string;
      };
    };
    expect(toolBody.tool).toMatchObject({
      id: "previewWorkflowTest",
      phase: "preview"
    });
    expect(toolBody.output.kind).toBe("workflow-test-preview");
    expect(toolBody.output.preview).toMatchObject({
      diagnostics: directBody.diagnostics,
      scope: directBody.scope,
      status: directBody.status,
      trigger: directBody.trigger,
      workflowVersionId: directBody.workflowVersionId
    });
    expect(
      ((toolBody.output.preview as { actions: Array<Record<string, unknown>> }).actions[0] as Record<
        string,
        unknown
      >).plan
    ).toEqual((directBody.actions[0] as { plan: Record<string, unknown> }).plan);
    expect(
      (toolBody.output.preview as { actions: Array<{ wouldRun: boolean }> }).actions[0]?.wouldRun
    ).toBe(directBody.actions[0]?.wouldRun);
  });

  it("fails closed for selected-record workflow previews when service identity metadata is missing", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        amount: 35
      },
      recordId: "rec_ticket_1",
      recordKey: "ticket-1",
      tableId: "tbl_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_ticket_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 35
    });
    insertWorkflow(db, {
      definition: {
        actions: [],
        conditions: [],
        metadata: {
          status: "draft",
          tableId: "tbl_1"
        },
        trigger: {
          match: {
            fieldId: "fld_ticket_amount",
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        },
        workflowId: "wf_invalid_preview"
      },
      name: "Invalid Preview",
      workflowId: "wf_invalid_preview",
      workflowKey: "invalid-preview"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_user_invalid_preview",
      workspaceId: "ws_1",
      principalId: "usr_workflow_preview",
      policyRevision: 18,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.manual"],
      fields: {
        fld_ticket_amount: {
          agent: true,
          fieldId: "fld_ticket_amount",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: false
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_invalid_preview/test-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 18,
          principalId: "usr_workflow_preview",
          recordId: "rec_ticket_1",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      reason: "workflow_service_identity_invalid",
      status: "rejected",
      workflowId: "wf_invalid_preview",
      workflowVersionId: "wf_invalid_preview:v1"
    });
  });

  it("drafts, executes, publishes, and reads back direct cross-table sync workflow proposals through ingress", async () => {
    const { db, env } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_accounts",
        "ws_1",
        "app_1",
        "accounts",
        "Accounts",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );

    insertField(db, {
      config: {
        allowMultiple: false,
        targetTableId: "tbl_accounts"
      },
      fieldId: "fld_ticket_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_ticket_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_account_status",
      fieldKey: "account_status",
      fieldType: "text.single_line",
      label: "Account Status",
      tableId: "tbl_accounts"
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_sync_workflow_execute",
      workspaceId: "ws_1",
      principalId: "agt_sync_workflow_execute",
      policyRevision: 53,
      schemaEpoch: 0,
      scopeHash: "scope:table:tbl_1",
      commandTypes: ["workflow.create", "workflow.publish"],
      fields: {
        fld_ticket_account: {
          agent: true,
          fieldId: "fld_ticket_account",
          fieldType: "relation.record",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_ticket_status: {
          agent: true,
          fieldId: "fld_ticket_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_account_status: {
          agent: true,
          fieldId: "fld_account_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const previewResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes/preview", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Sync ticket status into the linked account status.",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 53,
          principalId: "agt_sync_workflow_execute",
          name: "Ticket status sync",
          recipeType: "direct_sync",
          relatedSourceFieldId: "fld_ticket_account",
          syncSourceFieldId: "fld_ticket_status",
          syncTargetFieldId: "fld_account_status",
          workflowId: "wf_ticket_status_sync_execute",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(previewResponse.status).toBe(200);

    const previewBody = (await previewResponse.json()) as {
      output: {
        command: CommandEnvelope;
        proposal: {
          metadata: Record<string, unknown>;
        };
      };
    };
    expect(previewBody.output.proposal.metadata).toMatchObject({
      relatedTableResolvers: [
        {
          alias: "sync_fld_account_status",
          sourceFieldId: "fld_ticket_account",
          strategy: "single_relation",
          targetTableId: "tbl_accounts"
        }
      ]
    });
    expect(previewBody.output.command.payload).toMatchObject({
      definition: {
        actions: [
          {
            input: {
              resolverAlias: "sync_fld_account_status",
              sourceFieldId: "fld_ticket_status",
              targetFieldId: "fld_account_status"
            },
            operatorId: "sync_related_field"
          }
        ],
        metadata: {
          relatedTableResolvers: [
            {
              alias: "sync_fld_account_status",
              sourceFieldId: "fld_ticket_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ]
        },
        trigger: {
          match: {
            fieldIds: ["fld_ticket_status", "fld_ticket_account"],
            tableId: "tbl_1"
          },
          operatorId: "field_changed"
        }
      }
    });

    const createResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflow-recipes", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          businessRule: "Sync ticket status into the linked account status.",
          commandId: "cmd_create_sync_workflow_recipe",
          idempotencyKey: "idem_create_sync_workflow_recipe",
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 53,
          principalId: "agt_sync_workflow_execute",
          name: "Ticket status sync",
          recipeType: "direct_sync",
          relatedSourceFieldId: "fld_ticket_account",
          syncSourceFieldId: "fld_ticket_status",
          syncTargetFieldId: "fld_account_status",
          workflowId: "wf_ticket_status_sync_execute",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(createResponse.status).toBe(200);
    expect((await createResponse.json()) as Record<string, unknown>).toMatchObject({
      create: {
        result: {
          accepted: true
        }
      },
      recipeType: "direct_sync",
      status: "draft",
      workflowId: "wf_ticket_status_sync_execute"
    });

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_ticket_status_sync_execute/definition?workspaceId=ws_1&principalId=agt_sync_workflow_execute&permissionScopeHash=scope:table:tbl_1&policyRevision=53"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionResponse.status).toBe(200);
    expect((await definitionResponse.json()) as Record<string, unknown>).toMatchObject({
      definition: {
        actions: [
          {
            input: {
              resolverAlias: "sync_fld_account_status",
              sourceFieldId: "fld_ticket_status",
              targetFieldId: "fld_account_status"
            },
            operatorId: "sync_related_field"
          }
        ],
        metadata: {
          relatedTableResolvers: [
            {
              alias: "sync_fld_account_status",
              sourceFieldId: "fld_ticket_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            }
          ]
        }
      },
      workflowId: "wf_ticket_status_sync_execute",
      workflowKey: "ticket-status-sync-execute",
      workflowName: "Ticket status sync"
    });
  });

  it("rejects stale explicit permission coordinates on the execution ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_title",
      fieldKey: "title",
      fieldType: "text.single_line",
      label: "Title",
      tableId: "tbl_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            command: {
              commandId: "cmd_missing_snapshot",
              commandType: "view.create",
              idempotencyKey: "idem_missing_snapshot",
              payload: {},
              scope: "workspace",
              tableId: "tbl_1"
            }
          },
          permissionScopeHash: "scope:missing",
          policyRevision: 404,
          principalId: "agt_assist",
          toolId: "executeCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Requested permissionScopeHash scope:missing does not match resolved scope scope:table:tbl_1."
    );
  });

  it("resolves and stamps command-ingress permission coordinates before coordinator dispatch", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_member"
            },
            commandId: "cmd_permission_resolved",
            idempotencyKey: "idem_permission_resolved",
            payload: {
              filterFieldIds: [],
              sortFieldIds: ["fld_status"],
              viewId: "view_permission_resolved",
              viewName: "Permission Resolved",
              visibleFieldIds: ["fld_status"]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: {
        accepted: boolean;
        diagnostics: string[];
      };
    };
    expect(body.result).toMatchObject({
      accepted: true,
      diagnostics: []
    });

    const ledgerRow = await db
      .prepare(`SELECT metadata_json FROM event_ledger WHERE command_id = ?`)
      .bind("cmd_permission_resolved")
      .first<{ metadata_json: string }>();
    const metadata = JSON.parse(ledgerRow?.metadata_json ?? "{}") as {
      actor?: { mode?: string; principalId?: string };
      permissionScopeHash?: string | null;
      permissionsVersion?: number | null;
    };

    expect(metadata.actor).toEqual({
      mode: "user",
      principalId: "usr_member"
    });
    expect(metadata.permissionScopeHash).toBe("scope:table:tbl_1");
    expect(metadata.permissionsVersion).toBe(0);
  });

  it("rejects stale explicit permission coordinates on the command ingress", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_member"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_member"
            },
            commandId: "cmd_permission_stale",
            idempotencyKey: "idem_permission_stale",
            payload: {
              filterFieldIds: [],
              sortFieldIds: ["fld_status"],
              viewId: "view_permission_stale",
              viewName: "Permission Stale",
              visibleFieldIds: ["fld_status"]
            },
            permissionScopeHash: "scope:missing",
            permissionsVersion: 404
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Requested permissionScopeHash scope:missing does not match resolved scope scope:table:tbl_1."
    );
  });

  it("rejects non-execution tools on the execution ingress", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_execute_wrong_tool",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 23,
      schemaEpoch: 1,
      scopeHash: "scope:agent:execute:wrong-tool",
      fields: {}
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/agent-tools/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          input: {
            command: {
              commandId: "cmd_wrong_tool",
              commandType: "view.create",
              idempotencyKey: "idem_wrong_tool",
              payload: {},
              scope: "workspace",
              tableId: "tbl_1"
            }
          },
          principalId: "agt_assist",
          toolId: "dryRunCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain(
      "Only execution-phase agent tools are exposed on the execution ingress."
    );
  });

  it("creates a view through the command API and serves deterministic view metadata with permission-redacted rows", async () => {
    const { env } = createEnv();

    insertField(env.DB as unknown as SqliteD1Database, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(env.DB as unknown as SqliteD1Database, {
      fieldId: "fld_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });
    insertRecordProjection(env.DB as unknown as SqliteD1Database, {
      fields: {
        name: "Acme",
        salary: "120000"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertPermissionSnapshot(env.DB as unknown as SqliteD1Database, {
      snapshotId: "snap_view_member",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 4,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_comp",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_salary: {
          agent: false,
          fieldId: "fld_salary",
          fieldType: "number.decimal",
          read: "redacted",
          workflow: false,
          write: false
        }
      }
    });

    const createView = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_view_1",
            idempotencyKey: "idem_view_1",
            payload: {
              filterFieldIds: [],
              groupByFieldId: null,
              sortFieldIds: ["fld_name"],
              viewId: "view_comp",
              viewName: "Comp View",
              visibleFieldIds: ["fld_name", "fld_salary"]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(createView.status).toBe(200);

    const readView = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_comp?workspaceId=ws_1&principalId=usr_member"),
      env,
      {} as ExecutionContext
    );

    expect(readView.status).toBe(200);
    const body = (await readView.json()) as {
      fields: Array<{ fieldId: string; fieldKey: string }>;
      rows: Array<{
        cells: Record<string, unknown>;
        hiddenFieldIds: string[];
        recordId: string;
        redactedFieldIds: string[];
        states: Record<string, string>;
      }>;
      view: {
        allowed: boolean;
        redactedFieldIds: string[];
        redactionApplied: boolean;
        viewId: string;
        visibleFieldIds: string[];
      };
    };

    expect(body.view).toMatchObject({
      allowed: true,
      redactedFieldIds: ["fld_salary"],
      redactionApplied: true,
      viewId: "view_comp",
      visibleFieldIds: ["fld_name", "fld_salary"]
    });
    expect(body.fields).toMatchObject([
      {
        fieldId: "fld_name",
        fieldKey: "name",
        fieldType: "text.single_line",
        label: "Name"
      },
      {
        fieldId: "fld_salary",
        fieldKey: "salary",
        fieldType: "number.decimal",
        label: "Salary"
      }
    ]);
    expect(body.rows).toEqual([
      {
        cells: {
          fld_name: "Acme",
          fld_salary: "[redacted]"
        },
        hiddenFieldIds: [],
        recordId: "rec_1",
        recordKey: "record-1",
        redactedFieldIds: ["fld_salary"],
        states: {
          fld_name: "visible",
          fld_salary: "redacted"
        }
      }
    ]);
  });

  it("updates a saved view through the route ingress and reflects the new definition on reads immediately", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

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
      tableId: "tbl_1",
      config: {
        options: [
          { id: "active", label: "Active", semantic: "in_progress" },
          { id: "done", label: "Done", semantic: "done" }
        ]
      }
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_name",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_editor"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_editor"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        status: "active"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        status: "done"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_name",
      recordId: "rec_1",
      tableId: "tbl_1",
      textValue: "Alpha"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_name",
      recordId: "rec_2",
      tableId: "tbl_1",
      textValue: "Beta"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_1",
      tableId: "tbl_1",
      textValue: "active",
      numberValue: 0
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_2",
      tableId: "tbl_1",
      textValue: "done",
      numberValue: 1
    });
    insertView(db, {
      filterFieldIds: [],
      sortFieldIds: ["fld_name"],
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_name"]
    });

    const updateResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_pipeline", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_editor"
            },
            commandId: "cmd_view_update_route",
            idempotencyKey: "idem_view_update_route",
            payload: {
              filters: [
                {
                  fieldId: "fld_name",
                  operatorId: "is_not_empty"
                }
              ],
              groupByFieldId: "fld_status",
              showEmptyGroups: true,
              sorts: [
                {
                  fieldId: "fld_status",
                  mode: "descending"
                }
              ],
              viewName: "Active Pipeline",
              visibleFieldIds: ["fld_name", "fld_status"]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(updateResponse.status).toBe(200);
    const updateBody = (await updateResponse.json()) as {
      aggregate: { id: string; type: string } | null;
      result: {
        accepted: boolean;
        events: Array<{ commandType: string; eventType: string }>;
      };
    };
    expect(updateBody.aggregate).toEqual({
      id: "view_pipeline",
      type: "view"
    });
    expect(updateBody.result).toMatchObject({
      accepted: true,
      events: [
        {
          commandType: "view.update",
          eventType: "view.updated"
        }
      ]
    });
    expect(eventFanoutQueue.sent).toHaveLength(1);

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_pipeline/definition?workspaceId=ws_1&principalId=usr_editor"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionResponse.status).toBe(200);
    const definitionBody = (await definitionResponse.json()) as {
      definition: {
        filterFieldIds: string[];
        filters: Array<{ fieldId: string; operatorId: string; value?: unknown }>;
        groupByFieldId: string | null;
        sortFieldIds: string[];
        visibleFieldIds: string[];
      };
      viewName: string;
      viewSchemaVersion: number;
    };
    expect(definitionBody).toMatchObject({
      definition: {
        filterFieldIds: ["fld_name"],
        filters: [
          {
            fieldId: "fld_name",
            operatorId: "is_not_empty"
          }
        ],
        groupByFieldId: "fld_status",
        showEmptyGroups: true,
        sortFieldIds: ["fld_status"],
        visibleFieldIds: ["fld_name", "fld_status"]
      },
      viewName: "Active Pipeline",
      viewSchemaVersion: 2
    });

    const readResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_pipeline?workspaceId=ws_1&principalId=usr_editor"),
      env,
      {} as ExecutionContext
    );
    expect(readResponse.status).toBe(200);
    const readBody = (await readResponse.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
      rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      view: {
        viewName: string;
        visibleFieldIds: string[];
        viewSchemaVersion: number;
      };
    };
    expect(readBody.view).toMatchObject({
      viewName: "Active Pipeline",
      viewSchemaVersion: 2,
      visibleFieldIds: ["fld_name", "fld_status"]
    });
    expect(readBody.rows).toEqual([]);
    expect(readBody.groups?.map((group) => group.rowCount)).toEqual([1, 1]);
    expect(readBody.groups?.flatMap((group) => group.rows.map((row) => row.recordId)).sort()).toEqual([
      "rec_1",
      "rec_2"
    ]);
  });

  it("deletes a saved view through the route ingress and makes later definition/query reads return not found", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_name",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_editor"
    });
    insertView(db, {
      filterFieldIds: [],
      sortFieldIds: ["fld_name"],
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_name"]
    });

    const deleteResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_pipeline", {
        method: "DELETE",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_editor"
            },
            commandId: "cmd_view_delete_route",
            idempotencyKey: "idem_view_delete_route"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(deleteResponse.status).toBe(200);
    const deleteBody = (await deleteResponse.json()) as {
      aggregate: { id: string; type: string } | null;
      result: {
        accepted: boolean;
        events: Array<{ commandType: string; eventType: string }>;
      };
    };
    expect(deleteBody.aggregate).toEqual({
      id: "view_pipeline",
      type: "view"
    });
    expect(deleteBody.result).toMatchObject({
      accepted: true,
      events: [
        {
          commandType: "view.delete",
          eventType: "view.deleted"
        }
      ]
    });
    expect(eventFanoutQueue.sent).toHaveLength(1);

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_pipeline/definition?workspaceId=ws_1&principalId=usr_editor"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionResponse.status).toBe(404);
    await expect(definitionResponse.text()).resolves.toContain(
      "View view_pipeline was not found in table tbl_1."
    );

    const readResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_pipeline?workspaceId=ws_1&principalId=usr_editor"),
      env,
      {} as ExecutionContext
    );
    expect(readResponse.status).toBe(404);
    await expect(readResponse.text()).resolves.toContain("View view_pipeline was not found in table tbl_1.");
  });

  it("rejects saved-view route updates when the field type does not support grouping", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_tags",
      fieldKey: "tags",
      fieldType: "select.multi",
      label: "Tags",
      tableId: "tbl_1",
      config: {
        options: [
          { id: "vip", label: "VIP" },
          { id: "new", label: "New" }
        ]
      }
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_name",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_editor"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_tags",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "usr_editor"
    });
    insertView(db, {
      filterFieldIds: [],
      sortFieldIds: ["fld_name"],
      tableId: "tbl_1",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_name"]
    });

    const updateResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_pipeline", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_editor"
            },
            commandId: "cmd_view_update_group_capability_invalid",
            idempotencyKey: "idem_view_update_group_capability_invalid",
            payload: {
              groupByFieldId: "fld_tags",
              viewName: "Pipeline",
              visibleFieldIds: ["fld_name", "fld_tags"]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(updateResponse.status).toBe(200);
    const updateBody = (await updateResponse.json()) as {
      aggregate: { id: string; type: string } | null;
      result: { diagnostics: string[]; status: string };
    };
    expect(updateBody.aggregate).toEqual({
      id: "view_pipeline",
      type: "view"
    });
    expect(updateBody.result.status).toBe("rejected");
    expect(updateBody.result.diagnostics).toEqual(["view_group_unsupported:fld_tags"]);
    expect(eventFanoutQueue.sent).toHaveLength(0);

    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_pipeline/definition?workspaceId=ws_1&principalId=usr_editor"
      ),
      env,
      {} as ExecutionContext
    );
    expect(definitionResponse.status).toBe(200);
    const definitionBody = (await definitionResponse.json()) as {
      definition: {
        groupByFieldId: string | null;
        visibleFieldIds: string[];
      };
      viewName: string;
      viewSchemaVersion: number;
    };
    expect(definitionBody).toMatchObject({
      definition: {
        groupByFieldId: null,
        visibleFieldIds: ["fld_name"]
      },
      viewName: "Pipeline",
      viewSchemaVersion: 1
    });
  });

  it("executes saved filter definitions and non-default sort modes on the direct view read path", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        score: "9",
        status: null
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: "7",
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Gamma",
        score: "7",
        status: "active"
      },
      recordId: "rec_3",
      recordKey: "record-3",
      tableId: "tbl_1"
    });
    for (const [recordId, name, status, score] of [
      ["rec_1", "Beta", null, "9"],
      ["rec_2", "Alpha", "active", "7"],
      ["rec_3", "Gamma", "active", "7"]
    ] as const) {
      insertCellCurrent(db, {
        fieldId: "fld_name",
        fieldKey: "name",
        fieldType: "text.single_line",
        recordId,
        tableId: "tbl_1",
        value: name
      });
      insertCellCurrent(db, {
        fieldId: "fld_status",
        fieldKey: "status",
        fieldType: "status.semantic",
        recordId,
        tableId: "tbl_1",
        value: status
      });
      insertCellCurrent(db, {
        fieldId: "fld_score",
        fieldKey: "score",
        fieldType: "number.decimal",
        recordId,
        tableId: "tbl_1",
        value: score
      });
    }
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_2",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 7,
      recordId: "rec_2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_3",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 7,
      recordId: "rec_3",
      tableId: "tbl_1"
    });

    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "active"
        }
      ],
      sorts: [
        {
          fieldId: "fld_score",
          mode: "descending"
        }
      ],
      tableId: "tbl_1",
      viewId: "view_active_backlog",
      viewKey: "active-backlog",
      viewName: "Active Backlog",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_active_backlog",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 5,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_active_backlog",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const before = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_active_backlog?workspaceId=ws_1&principalId=usr_member&policyRevision=5&permissionScopeHash=scope:view:view_active_backlog"
      ),
      env,
      {} as ExecutionContext
    );
    const beforeBody = (await before.json()) as {
      fields: Array<{ fieldId: string }>;
      rows: Array<{ recordId: string; cells: Record<string, unknown> }>;
    };

    expect(beforeBody.fields).toEqual([
      {
        fieldId: "fld_name",
        fieldKey: "name",
        fieldType: "text.single_line",
        label: "Name"
      }
    ]);
    expect(beforeBody.rows.map((row) => row.recordId)).toEqual(["rec_2", "rec_3"]);
    expect(beforeBody.rows.map((row) => row.cells)).toEqual([
      {
        fld_name: "Alpha"
      },
      {
        fld_name: "Gamma"
      }
    ]);

    const activate = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_status_1",
            idempotencyKey: "idem_status_1",
            payload: {
              fieldType: "status.semantic",
              value: "active"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(activate.status).toBe(200);

    const reprioritize = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_score", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_score_1",
            idempotencyKey: "idem_score_1",
            payload: {
              fieldType: "number.decimal",
              value: "1"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(reprioritize.status).toBe(200);

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent[0]!, eventFanoutQueue.sent[1]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createBatch([projectionQueue.sent[0]!, projectionQueue.sent[1]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const after = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_active_backlog?workspaceId=ws_1&principalId=usr_member&policyRevision=5&permissionScopeHash=scope:view:view_active_backlog"
      ),
      env,
      {} as ExecutionContext
    );
    const afterBody = (await after.json()) as {
      rows: Array<{ recordId: string; cells: Record<string, unknown> }>;
    };

    expect(afterBody.rows.map((row) => row.recordId)).toEqual(["rec_2", "rec_3", "rec_1"]);
    expect(afterBody.rows.map((row) => row.cells)).toEqual([
      {
        fld_name: "Alpha"
      },
      {
        fld_name: "Gamma"
      },
      {
        fld_name: "Beta"
      }
    ]);
  });

  it("uses maintained field indexes for saved-view filters and ordering", async () => {
    const { db, env } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        score: 99,
        status: ""
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: 2,
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Gamma",
        score: 3,
        status: "active"
      },
      recordId: "rec_3",
      recordKey: "record-3",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_1",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_1",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_2",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      recordId: "rec_3",
      tableId: "tbl_1",
      textValue: "active"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 3,
      recordId: "rec_3",
      tableId: "tbl_1"
    });

    insertView(db, {
      filterFieldIds: ["fld_status"],
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_active_backlog",
      viewKey: "active-backlog",
      viewName: "Active Backlog",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_active_backlog_indexed",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 5,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_active_backlog",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_active_backlog?workspaceId=ws_1&principalId=usr_member&policyRevision=5&permissionScopeHash=scope:view:view_active_backlog"
      ),
      env,
      {} as ExecutionContext
    );
    const body = (await response.json()) as {
      rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
    };

    expect(body.rows.map((row) => row.recordId)).toEqual(["rec_1", "rec_2", "rec_3"]);
    expect(body.rows.map((row) => row.cells)).toEqual([
      {
        fld_name: "Beta"
      },
      {
        fld_name: "Alpha"
      },
      {
        fld_name: "Gamma"
      }
    ]);
  });

  it("returns grouped saved-view reads with stable group ordering, counts, and row ordering", async () => {
    const { db, env } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        score: 2,
        status: "backlog"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: 1,
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Gamma",
        score: 3,
        status: "active"
      },
      recordId: "rec_3",
      recordKey: "record-3",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_1",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 3,
      recordId: "rec_3",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_pipeline",
      viewKey: "grouped-pipeline",
      viewName: "Grouped Pipeline",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_pipeline",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 6,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_pipeline",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_pipeline?workspaceId=ws_1&principalId=usr_member&policyRevision=6&permissionScopeHash=scope:view:view_grouped_pipeline"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
      rows: Array<{ recordId: string }>;
      view: { actions?: Record<string, unknown>; allowed: boolean };
    };

    expect(body.view.allowed).toBe(true);
    expect(body.view.actions).toEqual({
      createRecord: {
        allowed: true,
        constrainedFieldIds: ["fld_status"],
        defaultCells: {},
        fieldId: "fld_status",
        fieldType: "status.semantic",
        reasons: [],
        requiresGroupValue: true,
        status: "writable"
      },
      groupMove: {
        allowed: true,
        fieldId: "fld_status",
        fieldType: "status.semantic",
        reasons: [],
        status: "writable"
      }
    });
    expect(body.rows).toEqual([]);
    expect(body.groups).toEqual([
      {
        bucketKey: "\"active\"",
        groupLabel: "active",
        groupValue: "active",
        rowCount: 2,
        rows: [
          {
            cells: {
              fld_name: "Alpha"
            },
            hiddenFieldIds: [],
            recordId: "rec_2",
            recordKey: "record-2",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          },
          {
            cells: {
              fld_name: "Gamma"
            },
            hiddenFieldIds: [],
            recordId: "rec_3",
            recordKey: "record-3",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"backlog\"",
        groupLabel: "backlog",
        groupValue: "backlog",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Beta"
            },
            hiddenFieldIds: [],
            recordId: "rec_1",
            recordKey: "record-1",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      }
    ]);
  });

  it("moves a grouped-view record through the grouped move route and preserves post-mutation ordering", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        score: 2,
        status: "backlog"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: 1,
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_1",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_2",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_pipeline",
      viewKey: "grouped-pipeline",
      viewName: "Grouped Pipeline",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_pipeline_move",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 10,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_pipeline",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const moveResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_pipeline/records/rec_1/group-move",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              actor: {
                mode: "user",
                principalId: "usr_member"
              },
              commandId: "cmd_group_move_1",
              idempotencyKey: "idem_group_move_1",
              permissionScopeHash: "scope:view:view_grouped_pipeline",
              permissionsVersion: 10,
              payload: {
                targetGroupValue: "active"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );

    expect(moveResponse.status).toBe(200);
    expect((await moveResponse.json()) as { viewAction: { type: string } }).toMatchObject({
      viewAction: {
        type: "groupMove"
      }
    });

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createBatch([projectionQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const afterResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_pipeline?workspaceId=ws_1&principalId=usr_member&policyRevision=10&permissionScopeHash=scope:view:view_grouped_pipeline"
      ),
      env,
      {} as ExecutionContext
    );

    expect(afterResponse.status).toBe(200);
    expect((await afterResponse.json()) as { groups?: Array<{ bucketKey: string; rows: Array<{ recordId: string }> }> }).toMatchObject({
      groups: [
        {
          bucketKey: "\"active\"",
          rows: [{ recordId: "rec_1" }, { recordId: "rec_2" }]
        }
      ]
    });
  });

  it("creates a grouped-view record through the view route and preserves post-create ordering", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Beta",
        score: 2,
        status: "backlog"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: 1,
        status: "active"
      },
      recordId: "rec_2",
      recordKey: "record-2",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_1",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_2",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_pipeline_create",
      viewKey: "grouped-pipeline-create",
      viewName: "Grouped Pipeline Create",
      visibleFieldIds: ["fld_name", "fld_score"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_pipeline_create",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 13,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_pipeline_create",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const createResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_grouped_pipeline_create/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            actor: {
              mode: "user",
              principalId: "usr_member"
            },
            commandId: "cmd_grouped_create_1",
            idempotencyKey: "idem_grouped_create_1",
            permissionScopeHash: "scope:view:view_grouped_pipeline_create",
            permissionsVersion: 13,
            payload: {
              cells: {
                fld_name: "Aardvark",
                fld_score: 0
              },
              recordId: "rec_0",
              targetGroupValue: "active"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(createResponse.status).toBe(200);
    expect((await createResponse.json()) as { viewAction: { defaultedFieldIds: string[]; type: string } }).toMatchObject({
      viewAction: {
        defaultedFieldIds: ["fld_status"],
        type: "createRecord"
      }
    });

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createBatch([projectionQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const afterResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_pipeline_create?workspaceId=ws_1&principalId=usr_member&policyRevision=13&permissionScopeHash=scope:view:view_grouped_pipeline_create"
      ),
      env,
      {} as ExecutionContext
    );

    expect(afterResponse.status).toBe(200);
    expect((await afterResponse.json()) as { groups?: Array<{ bucketKey: string; rows: Array<{ recordId: string }> }> }).toMatchObject({
      groups: [
        {
          bucketKey: "\"active\"",
          rows: [{ recordId: "rec_0" }, { recordId: "rec_2" }]
        },
        {
          bucketKey: "\"backlog\"",
          rows: [{ recordId: "rec_1" }]
        }
      ]
    });
  });

  it("rejects grouped-view moves that would violate grouping filters", async () => {
    const { db, env } = createEnv();

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
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        score: 1,
        status: "active"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_1",
      tableId: "tbl_1"
    });

    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "active"
        }
      ],
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_active_only",
      viewKey: "grouped-active-only",
      viewName: "Grouped Active Only",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_active_only",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 11,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_active_only",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_active_only/records/rec_1/group-move",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              actor: {
                mode: "user",
                principalId: "usr_member"
              },
              commandId: "cmd_group_move_filter_mismatch",
              idempotencyKey: "idem_group_move_filter_mismatch",
              permissionScopeHash: "scope:view:view_grouped_active_only",
              permissionsVersion: 11,
              payload: {
                targetGroupValue: "backlog"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as { details: { reason: string } }).toMatchObject({
      details: {
        reason: "view_group_move_filter_mismatch"
      }
    });
  });

  it("rejects view-scoped creates that conflict with protected filter defaults", async () => {
    const { db, env } = createEnv();

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

    insertView(db, {
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "active"
        }
      ],
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_grouped_active_create_only",
      viewKey: "grouped-active-create-only",
      viewName: "Grouped Active Create Only",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_active_create_only",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 14,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_active_create_only",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_active_create_only/records",
        {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              actor: {
                mode: "user",
                principalId: "usr_member"
              },
              commandId: "cmd_grouped_create_filter_conflict",
              idempotencyKey: "idem_grouped_create_filter_conflict",
              permissionScopeHash: "scope:view:view_grouped_active_create_only",
              permissionsVersion: 14,
              payload: {
                cells: {
                  fld_name: "Mismatch",
                  fld_status: "backlog"
                },
                recordId: "rec_conflict",
                targetGroupValue: "active"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(409);
    expect((await response.json()) as { details: { reason: string } }).toMatchObject({
      details: {
        reason: "view_create_constraint_mismatch"
      }
    });
  });

  it("surfaces hidden and read-only grouped move affordances without widening access", async () => {
    const { db, env } = createEnv();

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
    insertRecordProjection(db, {
      fields: {
        name: "Alpha",
        status: "active"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_hidden_group_move",
      viewKey: "hidden-group-move",
      viewName: "Hidden Group Move",
      visibleFieldIds: ["fld_name"]
    });
    insertView(db, {
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_read_only_group_move",
      viewKey: "read-only-group-move",
      viewName: "Read Only Group Move",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_hidden_group_move",
      workspaceId: "ws_1",
      principalId: "usr_hidden",
      policyRevision: 12,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_hidden_group_move",
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
          read: "hidden",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_read_only_group_move",
      workspaceId: "ws_1",
      principalId: "usr_read_only",
      policyRevision: 12,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_read_only_group_move",
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
          write: false
        }
      }
    });

    const hiddenResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_hidden_group_move?workspaceId=ws_1&principalId=usr_hidden&policyRevision=12&permissionScopeHash=scope:view:view_hidden_group_move"
      ),
      env,
      {} as ExecutionContext
    );
    const readOnlyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_read_only_group_move?workspaceId=ws_1&principalId=usr_read_only&policyRevision=12&permissionScopeHash=scope:view:view_read_only_group_move"
      ),
      env,
      {} as ExecutionContext
    );

    expect((await hiddenResponse.json()) as { view: { actions: { groupMove: { status: string } } } }).toMatchObject({
      view: {
        actions: {
          groupMove: {
            status: "hidden"
          }
        }
      }
    });
    expect((await readOnlyResponse.json()) as { view: { actions: { groupMove: { status: string } } } }).toMatchObject({
      view: {
        actions: {
          groupMove: {
            status: "read_only"
          }
        }
      }
    });
  });

  it("surfaces hidden and read-only create affordances without widening access", async () => {
    const { db, env } = createEnv();

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

    insertView(db, {
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_hidden_create",
      viewKey: "hidden-create",
      viewName: "Hidden Create",
      visibleFieldIds: ["fld_name"]
    });
    insertView(db, {
      groupByFieldId: "fld_status",
      tableId: "tbl_1",
      viewId: "view_read_only_create",
      viewKey: "read-only-create",
      viewName: "Read Only Create",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_hidden_create",
      workspaceId: "ws_1",
      principalId: "usr_hidden",
      policyRevision: 15,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_hidden_create",
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
          read: "hidden",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_read_only_create",
      workspaceId: "ws_1",
      principalId: "usr_read_only",
      policyRevision: 15,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_read_only_create",
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
          write: false
        }
      }
    });

    const hiddenResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_hidden_create?workspaceId=ws_1&principalId=usr_hidden&policyRevision=15&permissionScopeHash=scope:view:view_hidden_create"
      ),
      env,
      {} as ExecutionContext
    );
    const readOnlyResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_read_only_create?workspaceId=ws_1&principalId=usr_read_only&policyRevision=15&permissionScopeHash=scope:view:view_read_only_create"
      ),
      env,
      {} as ExecutionContext
    );

    expect((await hiddenResponse.json()) as { view: { actions: { createRecord: { status: string } } } }).toMatchObject({
      view: {
        actions: {
          createRecord: {
            status: "hidden"
          }
        }
      }
    });
    expect((await readOnlyResponse.json()) as { view: { actions: { createRecord: { status: string } } } }).toMatchObject({
      view: {
        actions: {
          createRecord: {
            status: "read_only"
          }
        }
      }
    });
  });

  it("uses configured status labels and option order in grouped saved-view reads", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        options: [
          { id: "todo", label: "Todo", semantic: "todo" },
          { id: "in_progress", label: "In Progress", semantic: "in_progress" },
          { id: "done", label: "Done", semantic: "done" }
        ]
      },
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Finish docs",
        score: 3,
        status: "done"
      },
      recordId: "rec_done",
      recordKey: "record-done",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Start rollout",
        score: 2,
        status: "in_progress"
      },
      recordId: "rec_progress",
      recordKey: "record-progress",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Open queue",
        score: 1,
        status: "todo"
      },
      recordId: "rec_todo",
      recordKey: "record-todo",
      tableId: "tbl_1"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 3,
      recordId: "rec_done",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_progress",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_todo",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_status_semantic",
      viewKey: "grouped-status-semantic",
      viewName: "Grouped Status Semantic",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_status_semantic",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 8,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_status_semantic",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_status_semantic?workspaceId=ws_1&principalId=usr_member&policyRevision=8&permissionScopeHash=scope:view:view_grouped_status_semantic"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
    };

    expect(body.groups).toEqual([
      {
        bucketKey: "\"todo\"",
        groupLabel: "Todo",
        groupValue: "todo",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Open queue"
            },
            hiddenFieldIds: [],
            recordId: "rec_todo",
            recordKey: "record-todo",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"in_progress\"",
        groupLabel: "In Progress",
        groupValue: "in_progress",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Start rollout"
            },
            hiddenFieldIds: [],
            recordId: "rec_progress",
            recordKey: "record-progress",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"done\"",
        groupLabel: "Done",
        groupValue: "done",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Finish docs"
            },
            hiddenFieldIds: [],
            recordId: "rec_done",
            recordKey: "record-done",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      }
    ]);
  });

  it("emits configured empty option groups only when grouped saved-view empty groups are enabled", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        options: [
          { id: "todo", label: "Todo", semantic: "todo" },
          { id: "in_progress", label: "In Progress", semantic: "in_progress" },
          { id: "done", label: "Done", semantic: "done" }
        ]
      },
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Open queue",
        score: 1,
        status: "todo"
      },
      recordId: "rec_todo",
      recordKey: "record-todo",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_todo",
      tableId: "tbl_1"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      showEmptyGroups: true,
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_status_with_empty",
      viewKey: "grouped-status-with-empty",
      viewName: "Grouped Status With Empty",
      visibleFieldIds: ["fld_name"]
    });
    insertView(db, {
      groupByFieldId: "fld_status",
      showEmptyGroups: false,
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_status_without_empty",
      viewKey: "grouped-status-without-empty",
      viewName: "Grouped Status Without Empty",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_status_with_empty",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 9,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_status_with_empty",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_status_without_empty",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 9,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_status_without_empty",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const enabledResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_status_with_empty?workspaceId=ws_1&principalId=usr_member&policyRevision=9&permissionScopeHash=scope:view:view_grouped_status_with_empty"
      ),
      env,
      {} as ExecutionContext
    );
    const disabledResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_status_without_empty?workspaceId=ws_1&principalId=usr_member&policyRevision=9&permissionScopeHash=scope:view:view_grouped_status_without_empty"
      ),
      env,
      {} as ExecutionContext
    );

    expect(enabledResponse.status).toBe(200);
    expect(disabledResponse.status).toBe(200);

    const enabledBody = (await enabledResponse.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
    };
    const disabledBody = (await disabledResponse.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
    };

    expect(enabledBody.groups).toEqual([
      {
        bucketKey: "\"todo\"",
        groupLabel: "Todo",
        groupValue: "todo",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Open queue"
            },
            hiddenFieldIds: [],
            recordId: "rec_todo",
            recordKey: "record-todo",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"in_progress\"",
        groupLabel: "In Progress",
        rowCount: 0,
        rows: []
      },
      {
        bucketKey: "\"done\"",
        groupLabel: "Done",
        rowCount: 0,
        rows: []
      }
    ]);
    expect(disabledBody.groups).toEqual([
      {
        bucketKey: "\"todo\"",
        groupLabel: "Todo",
        groupValue: "todo",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Open queue"
            },
            hiddenFieldIds: [],
            recordId: "rec_todo",
            recordKey: "record-todo",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      }
    ]);
  });

  it("backfills grouped saved-view ordering and labels after field option updates", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        options: [
          { id: "todo", label: "Todo", semantic: "todo" },
          { id: "in_progress", label: "In Progress", semantic: "in_progress" },
          { id: "done", label: "Done", semantic: "done" }
        ]
      },
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Finish docs",
        score: 3,
        status: "done"
      },
      recordId: "rec_done",
      recordKey: "record-done",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Start rollout",
        score: 2,
        status: "in_progress"
      },
      recordId: "rec_progress",
      recordKey: "record-progress",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        name: "Open queue",
        score: 1,
        status: "todo"
      },
      recordId: "rec_todo",
      recordKey: "record-todo",
      tableId: "tbl_1"
    });

    insertCellCurrent(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      recordId: "rec_done",
      tableId: "tbl_1",
      value: "done"
    });
    insertCellCurrent(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      recordId: "rec_progress",
      tableId: "tbl_1",
      value: "in_progress"
    });
    insertCellCurrent(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      recordId: "rec_todo",
      tableId: "tbl_1",
      value: "todo"
    });

    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 3,
      recordId: "rec_done",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 2,
      recordId: "rec_progress",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_score",
      numberValue: 1,
      recordId: "rec_todo",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      numberValue: 0,
      recordId: "rec_todo",
      tableId: "tbl_1",
      textValue: "Todo"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      numberValue: 1,
      recordId: "rec_progress",
      tableId: "tbl_1",
      textValue: "In Progress"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_status",
      numberValue: 2,
      recordId: "rec_done",
      tableId: "tbl_1",
      textValue: "Done"
    });

    insertView(db, {
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_score"],
      tableId: "tbl_1",
      viewId: "view_grouped_status_semantic",
      viewKey: "grouped-status-semantic",
      viewName: "Grouped Status Semantic",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_status_semantic",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 8,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_status_semantic",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_score: {
          agent: true,
          fieldId: "fld_score",
          fieldType: "number.decimal",
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
      }
    });

    const updateResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_status_option_update",
            idempotencyKey: "idem_field_status_option_update",
            payload: {
              config: {
                options: [
                  { id: "done", label: "Done", semantic: "done" },
                  { id: "in_progress", label: "Working", semantic: "in_progress" },
                  { id: "todo", label: "Queued", semantic: "todo" }
                ]
              }
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(updateResponse.status).toBe(200);

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_status_semantic?workspaceId=ws_1&principalId=usr_member&policyRevision=8&permissionScopeHash=scope:view:view_grouped_status_semantic"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groups?: Array<{
        bucketKey: string;
        groupLabel: string;
        rowCount: number;
        rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
      }>;
    };

    expect(body.groups).toEqual([
      {
        bucketKey: "\"done\"",
        groupLabel: "Done",
        groupValue: "done",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Finish docs"
            },
            hiddenFieldIds: [],
            recordId: "rec_done",
            recordKey: "record-done",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"in_progress\"",
        groupLabel: "Working",
        groupValue: "in_progress",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Start rollout"
            },
            hiddenFieldIds: [],
            recordId: "rec_progress",
            recordKey: "record-progress",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      },
      {
        bucketKey: "\"todo\"",
        groupLabel: "Queued",
        groupValue: "todo",
        rowCount: 1,
        rows: [
          {
            cells: {
              fld_name: "Open queue"
            },
            hiddenFieldIds: [],
            recordId: "rec_todo",
            recordKey: "record-todo",
            redactedFieldIds: [],
            states: {
              fld_name: "visible"
            }
          }
        ]
      }
    ]);
  });

  it("accepts hardened non-select field config updates through field.update routes", async () => {
    const { env } = createEnv();
    const db = env.DB as unknown as SqliteD1Database;

    insertField(db, {
      config: {
        precision: 2
      },
      fieldId: "fld_score",
      fieldKey: "score",
      fieldType: "number.decimal",
      label: "Score",
      tableId: "tbl_1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields/fld_score", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_score_config_update",
            idempotencyKey: "idem_field_score_config_update",
            payload: {
              config: {
                display: "currency",
                integerOnly: true
              }
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);

    const fieldRow = db.inner
      .prepare(
        `SELECT config_json
         FROM fields
         WHERE workspace_id = ? AND table_id = ? AND id = ?`
      )
      .get("ws_1", "tbl_1", "fld_score") as {
      config_json: string;
    };

    expect(JSON.parse(fieldRow.config_json)).toEqual({
      display: "currency",
      integerOnly: true,
      precision: 2
    });
  });

  it("supports field.archive through the field routes and removes archived fields from schema and record reads", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_archive_route_create",
            idempotencyKey: "idem_field_archive_route_create",
            payload: {
              fieldId: "fld_title",
              fieldKey: "title",
              fieldType: "text.single_line",
              label: "Title"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_archive_route_create",
            idempotencyKey: "idem_record_archive_route_create",
            payload: {
              cells: {
                fld_title: "Archive me"
              },
              recordId: "rec_field_archive_route"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    const archiveResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields/fld_title", {
        method: "DELETE",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_archive_route_delete",
            idempotencyKey: "idem_field_archive_route_delete"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(archiveResponse.status).toBe(200);
    const archiveBody = (await archiveResponse.json()) as {
      result: { events: Array<{ eventType: string }> };
    };
    expect(archiveBody.result.events[0]?.eventType).toBe("field.archived");

    const schemaResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_field_archive"),
      env,
      {} as ExecutionContext
    );
    expect(schemaResponse.status).toBe(200);
    const schemaBody = (await schemaResponse.json()) as {
      fields: Array<{ fieldId: string }>;
    };
    expect(schemaBody.fields).toEqual([]);

    const recordResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_field_archive_route?workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(recordResponse.status).toBe(200);
    const recordBody = (await recordResponse.json()) as {
      projection: { fields: Record<string, unknown> };
    };
    expect(recordBody.projection.fields).toEqual({});

    const mutateArchivedFieldResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_field_archive_route/cells/fld_title",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_field_archive_route_mutate",
              idempotencyKey: "idem_field_archive_route_mutate",
              payload: {
                value: "Still here?"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(mutateArchivedFieldResponse.status).toBe(200);
    const mutateArchivedFieldBody = (await mutateArchivedFieldResponse.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(mutateArchivedFieldBody.result.status).toBe("rejected");
    expect(mutateArchivedFieldBody.result.diagnostics).toEqual(["field_not_found:fld_title"]);
  });

  it("supports field.reorder through the field routes and returns canonical schema/read ordering", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_reorder_route_create_title",
            idempotencyKey: "idem_field_reorder_route_create_title",
            payload: {
              fieldId: "fld_title",
              fieldKey: "title",
              fieldType: "text.single_line",
              label: "Title"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_reorder_route_create_status",
            idempotencyKey: "idem_field_reorder_route_create_status",
            payload: {
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "status.semantic",
              label: "Status"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_reorder_route_create_eta",
            idempotencyKey: "idem_field_reorder_route_create_eta",
            payload: {
              fieldId: "fld_eta",
              fieldKey: "eta",
              fieldType: "date.date",
              label: "ETA"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_reorder_route_record",
            idempotencyKey: "idem_field_reorder_route_record",
            payload: {
              cells: {
                fld_eta: "2026-06-30",
                fld_status: "todo",
                fld_title: "Field ordering"
              },
              recordId: "rec_field_reorder_route"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    const reorderResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields:reorder", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_reorder_route_apply",
            idempotencyKey: "idem_field_reorder_route_apply",
            payload: {
              fieldIds: ["fld_eta", "fld_title", "fld_status"]
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(reorderResponse.status).toBe(200);
    const reorderBody = (await reorderResponse.json()) as {
      result: { events: Array<{ eventType: string }> };
    };
    expect(reorderBody.result.events[0]?.eventType).toBe("field.reordered");

    const schemaResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_field_archive"),
      env,
      {} as ExecutionContext
    );
    expect(schemaResponse.status).toBe(200);
    const schemaBody = (await schemaResponse.json()) as {
      fields: Array<{ fieldId: string }>;
    };
    expect(schemaBody.fields.map((field) => field.fieldId)).toEqual([
      "fld_eta",
      "fld_title",
      "fld_status"
    ]);

    const recordResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_field_reorder_route?workspaceId=ws_1"
      ),
      env,
      {} as ExecutionContext
    );
    expect(recordResponse.status).toBe(200);
    const recordBody = (await recordResponse.json()) as {
      projection: { fields: Record<string, unknown> };
    };
    expect(Object.keys(recordBody.projection.fields)).toEqual(["eta", "title", "status"]);
  });

  it("rejects non-select field config tightening through field.update routes when stored cells conflict", async () => {
    const { env } = createEnv();

    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_score_tightening_create",
            idempotencyKey: "idem_field_score_tightening_create",
            payload: {
              config: {
                precision: 3
              },
              fieldId: "fld_score",
              fieldKey: "score",
              fieldType: "number.decimal",
              label: "Score"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_score_tightening_create",
            idempotencyKey: "idem_record_score_tightening_create",
            payload: {
              cells: {
                fld_score: "4.567"
              },
              recordId: "rec_score_tightening"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields/fld_score", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_score_tightening_update",
            idempotencyKey: "idem_field_score_tightening_update",
            payload: {
              config: {
                precision: 2
              }
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(body.result.status).toBe("rejected");
    expect(body.result.diagnostics).toEqual([
      "Expected number.decimal value to use at most 2 decimal places."
    ]);
  });

  it("surfaces select/status field config diagnostics through the field.create route ingress", async () => {
    const { env, eventFanoutQueue } = createEnv();

    const invalidSelect = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_select_route",
            idempotencyKey: "idem_field_invalid_select_route",
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
              fieldId: "fld_stage",
              fieldKey: "stage",
              fieldType: "select.single",
              label: "Stage"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidSelect.status).toBe(200);
    const invalidSelectBody = (await invalidSelect.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidSelectBody.result.status).toBe("rejected");
    expect(invalidSelectBody.result.diagnostics).toEqual([
      "invalid_field_config:select.single:Field option 0 contains unsupported property: extra.",
      "invalid_field_config:select.single:Field option 0 id must be a non-empty string.",
      "invalid_field_config:select.single:Field option 1 label must be a non-empty string.",
      "invalid_field_config:select.single:Field option ids must be unique: ready."
    ]);

    const invalidStatus = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_status_route",
            idempotencyKey: "idem_field_invalid_status_route",
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
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "status.semantic",
              label: "Status"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidStatus.status).toBe(200);
    const invalidStatusBody = (await invalidStatus.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidStatusBody.result.status).toBe("rejected");
    expect(invalidStatusBody.result.diagnostics).toEqual([
      "invalid_field_config:status.semantic:Status option todo is missing a semantic value.",
      "invalid_field_config:status.semantic:Status option doing has unsupported semantic: moving."
    ]);
    expect(eventFanoutQueue.sent).toEqual([]);
  });

  it("surfaces boolean/date field config diagnostics through the field.create route ingress", async () => {
    const { env, eventFanoutQueue } = createEnv();

    const invalidBoolean = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_boolean_route",
            idempotencyKey: "idem_field_invalid_boolean_route",
            payload: {
              config: {
                unexpected: true
              },
              fieldId: "fld_done",
              fieldKey: "done",
              fieldType: "boolean.checkbox",
              label: "Done"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidBoolean.status).toBe(200);
    const invalidBooleanBody = (await invalidBoolean.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidBooleanBody.result.status).toBe("rejected");
    expect(invalidBooleanBody.result.diagnostics).toEqual([
      "invalid_field_config:boolean.checkbox:Field configuration contains unsupported property: unexpected."
    ]);

    const invalidDate = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_date_route",
            idempotencyKey: "idem_field_invalid_date_route",
            payload: {
              config: {
                timezone: "UTC"
              },
              fieldId: "fld_due_date",
              fieldKey: "dueDate",
              fieldType: "date.date",
              label: "Due Date"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidDate.status).toBe(200);
    const invalidDateBody = (await invalidDate.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidDateBody.result.status).toBe("rejected");
    expect(invalidDateBody.result.diagnostics).toEqual([
      "invalid_field_config:date.date:Field configuration contains unsupported property: timezone."
    ]);

    const invalidDatetime = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_datetime_route",
            idempotencyKey: "idem_field_invalid_datetime_route",
            payload: {
              config: {
                timezone: "UTC"
              },
              fieldId: "fld_due_at",
              fieldKey: "dueAt",
              fieldType: "date.datetime",
              label: "Due At"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidDatetime.status).toBe(200);
    const invalidDatetimeBody = (await invalidDatetime.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidDatetimeBody.result.status).toBe("rejected");
    expect(invalidDatetimeBody.result.diagnostics).toEqual([
      "invalid_field_config:date.datetime:Field configuration contains unsupported property: timezone."
    ]);
    expect(eventFanoutQueue.sent).toEqual([]);
  });

  it("surfaces principal/relation/computed field config diagnostics through the field.create route ingress", async () => {
    const { env, eventFanoutQueue } = createEnv();

    const invalidPrincipal = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_principal_route",
            idempotencyKey: "idem_field_invalid_principal_route",
            payload: {
              config: {
                allowedRoleIds: ["admin", "admin", ""]
              },
              fieldId: "fld_assignee",
              fieldKey: "assignee",
              fieldType: "principal.user",
              label: "Assignee"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidPrincipal.status).toBe(200);
    const invalidPrincipalBody = (await invalidPrincipal.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidPrincipalBody.result.status).toBe("rejected");
    expect(invalidPrincipalBody.result.diagnostics).toEqual([
      "invalid_field_config:principal.user:allowedRoleIds entries must be unique: admin.",
      "invalid_field_config:principal.user:allowedRoleIds entry 2 must be a non-empty string."
    ]);

    const invalidRelation = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_relation_route",
            idempotencyKey: "idem_field_invalid_relation_route",
            payload: {
              config: {
                allowMultiple: "yes"
              },
              fieldId: "fld_related_task",
              fieldKey: "relatedTask",
              fieldType: "relation.record",
              label: "Related Task"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidRelation.status).toBe(200);
    const invalidRelationBody = (await invalidRelation.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidRelationBody.result.status).toBe("rejected");
    expect(invalidRelationBody.result.diagnostics).toEqual([
      "invalid_field_config:relation.record:Field configuration targetTableId must be a non-empty string.",
      "invalid_field_config:relation.record:Field configuration allowMultiple must be a boolean."
    ]);

    const invalidComputed = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_invalid_computed_route",
            idempotencyKey: "idem_field_invalid_computed_route",
            payload: {
              config: {
                dependsOnFieldIds: ["fld_title", "fld_title"],
                expression: ""
              },
              fieldId: "fld_health_score",
              fieldKey: "healthScore",
              fieldType: "computed.readonly",
              label: "Health Score"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(invalidComputed.status).toBe(200);
    const invalidComputedBody = (await invalidComputed.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidComputedBody.result.status).toBe("rejected");
    expect(invalidComputedBody.result.diagnostics).toEqual([
      "invalid_field_config:computed.readonly:Field configuration expression must be a non-empty string.",
      "invalid_field_config:computed.readonly:dependsOnFieldIds entries must be unique: fld_title."
    ]);
    expect(eventFanoutQueue.sent).toEqual([]);
  });

  it("surfaces select/status cell value diagnostics through the cell.set route ingress", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

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
      tableId: "tbl_1"
    });
    insertField(db, {
      config: {
        options: [{ id: "todo", label: "Todo", semantic: "todo" }]
      },
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_tags",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_status",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_invalid_select_status_setup",
            idempotencyKey: "idem_record_invalid_select_status_setup",
            payload: {
              recordId: "rec_invalid_select_status"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const invalidSelect = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_select_status/cells/fld_tags",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_select_multi_route",
              idempotencyKey: "idem_cell_invalid_select_multi_route",
              payload: {
                value: ["alpha", "missing"]
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidSelect.status).toBe(200);
    const invalidSelectBody = (await invalidSelect.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidSelectBody.result.status).toBe("rejected");
    expect(invalidSelectBody.result.diagnostics).toEqual([
      "Unknown option id for select.multi: missing."
    ]);

    const invalidStatus = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_select_status/cells/fld_status",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_status_route",
              idempotencyKey: "idem_cell_invalid_status_route",
              payload: {
                value: "missing"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidStatus.status).toBe(200);
    const invalidStatusBody = (await invalidStatus.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidStatusBody.result.status).toBe("rejected");
    expect(invalidStatusBody.result.diagnostics).toEqual([
      "Unknown option id for status.semantic: missing."
    ]);
    expect(eventFanoutQueue.sent).toHaveLength(1);
  });

  it("surfaces boolean/date cell value diagnostics through the cell.set route ingress", async () => {
    const { db, env, eventFanoutQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_done",
      fieldKey: "done",
      fieldType: "boolean.checkbox",
      label: "Done",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_due_date",
      fieldKey: "dueDate",
      fieldType: "date.date",
      label: "Due Date",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_due_at",
      fieldKey: "dueAt",
      fieldType: "date.datetime",
      label: "Due At",
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_done",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_due_date",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_due_at",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_invalid_boolean_date_setup",
            idempotencyKey: "idem_record_invalid_boolean_date_setup",
            payload: {
              recordId: "rec_invalid_boolean_date"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const invalidBoolean = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_boolean_date/cells/fld_done",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_boolean_route",
              idempotencyKey: "idem_cell_invalid_boolean_route",
              payload: {
                value: "maybe"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidBoolean.status).toBe(200);
    const invalidBooleanBody = (await invalidBoolean.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidBooleanBody.result.status).toBe("rejected");
    expect(invalidBooleanBody.result.diagnostics).toEqual([
      "Expected boolean.checkbox value to be a boolean or null."
    ]);

    const invalidDate = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_boolean_date/cells/fld_due_date",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_date_route",
              idempotencyKey: "idem_cell_invalid_date_route",
              payload: {
                value: "2026-02-30"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidDate.status).toBe(200);
    const invalidDateBody = (await invalidDate.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidDateBody.result.status).toBe("rejected");
    expect(invalidDateBody.result.diagnostics).toEqual([
      "Expected date.date value to use YYYY-MM-DD format."
    ]);

    const invalidDatetime = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_boolean_date/cells/fld_due_at",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_datetime_route",
              idempotencyKey: "idem_cell_invalid_datetime_route",
              payload: {
                value: "2026-06-06T00:00:00"
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidDatetime.status).toBe(200);
    const invalidDatetimeBody = (await invalidDatetime.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidDatetimeBody.result.status).toBe("rejected");
    expect(invalidDatetimeBody.result.diagnostics).toEqual([
      "Expected date.datetime value to use an ISO datetime with timezone."
    ]);
    expect(eventFanoutQueue.sent).toHaveLength(1);
  });

  it("surfaces principal/relation cell value diagnostics through the cell.set route ingress", async () => {
    const { db, env, eventFanoutQueue } = createEnv();
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
        "ws_1",
        "app_1",
        "related-tasks",
        "Related Tasks",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );

    insertField(db, {
      fieldId: "fld_assignee",
      fieldKey: "assignee",
      fieldType: "principal.user",
      label: "Assignee",
      tableId: "tbl_1"
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
      tableId: "tbl_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_assignee",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });
    setFieldPrincipalPermission(db, {
      fieldId: "fld_related_task",
      permission: {
        agent: true,
        read: "visible",
        workflow: true,
        write: true
      },
      principalId: "principal_1"
    });

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_invalid_principal_relation_setup",
            idempotencyKey: "idem_record_invalid_principal_relation_setup",
            payload: {
              recordId: "rec_invalid_principal_relation"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const invalidPrincipal = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_principal_relation/cells/fld_assignee",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_principal_route",
              idempotencyKey: "idem_cell_invalid_principal_route",
              payload: {
                value: ["user_1", "user_1"]
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidPrincipal.status).toBe(200);
    const invalidPrincipalBody = (await invalidPrincipal.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidPrincipalBody.result.status).toBe("rejected");
    expect(invalidPrincipalBody.result.diagnostics).toEqual([
      "Expected principal.user value entries to be unique: user_1."
    ]);

    const invalidRelation = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_principal_relation/cells/fld_related_task",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_invalid_relation_route",
              idempotencyKey: "idem_cell_invalid_relation_route",
              payload: {
                value: ["rec_1", "rec_2"]
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(invalidRelation.status).toBe(200);
    const invalidRelationBody = (await invalidRelation.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(invalidRelationBody.result.status).toBe("rejected");
    expect(invalidRelationBody.result.diagnostics).toEqual([
      "Expected relation.record value to contain at most one record id."
    ]);

    insertRecord(db, {
      recordId: "rec_wrong_relation_table",
      recordKey: "wrong-relation-table",
      tableId: "tbl_1"
    });

    const wrongTableRelation = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/records/rec_invalid_principal_relation/cells/fld_related_task",
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify(
            createRouteBody({
              commandId: "cmd_cell_wrong_table_relation_route",
              idempotencyKey: "idem_cell_wrong_table_relation_route",
              payload: {
                value: ["rec_wrong_relation_table"]
              }
            })
          )
        }
      ),
      env,
      {} as ExecutionContext
    );
    expect(wrongTableRelation.status).toBe(200);
    const wrongTableRelationBody = (await wrongTableRelation.json()) as {
      result: { diagnostics: string[]; status: string };
    };
    expect(wrongTableRelationBody.result.status).toBe("rejected");
    expect(wrongTableRelationBody.result.diagnostics).toEqual([
      "Expected relation.record reference rec_wrong_relation_table to belong to table tbl_related, found tbl_1."
    ]);
    expect(eventFanoutQueue.sent).toHaveLength(1);
  });

  it("denies grouped saved-view reads when the grouping field is redacted", async () => {
    const { db, env } = createEnv();

    insertField(db, {
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });

    insertRecordProjection(db, {
      fields: {
        name: "Acme",
        salary: "120000"
      },
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertView(db, {
      groupByFieldId: "fld_salary",
      tableId: "tbl_1",
      viewId: "view_grouped_comp",
      viewKey: "grouped-comp",
      viewName: "Grouped Comp",
      visibleFieldIds: ["fld_name"]
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_grouped_comp_member",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 7,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_grouped_comp",
      fields: {
        fld_name: {
          agent: true,
          fieldId: "fld_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_salary: {
          agent: false,
          fieldId: "fld_salary",
          fieldType: "number.decimal",
          read: "redacted",
          workflow: false,
          write: false
        }
      }
    });

    const response = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_grouped_comp?workspaceId=ws_1&principalId=usr_member&policyRevision=7&permissionScopeHash=scope:view:view_grouped_comp"
      ),
      env,
      {} as ExecutionContext
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groups?: unknown[];
      rows: unknown[];
      view: { allowed: boolean; blockedFieldIds: string[]; diagnostics: string[] };
    };

    expect(body.view.allowed).toBe(false);
    expect(body.view.blockedFieldIds).toEqual(["fld_salary"]);
    expect(body.view.diagnostics).toContain("view_constraint_hidden:fld_salary");
    expect(body.rows).toEqual([]);
    expect(body.groups).toBeUndefined();
  });

  it("enforces permissioned view reads across two tables for owner, member, and agent-like principals", async () => {
    const { db, env } = createEnv();
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
        "app_1",
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
      fieldId: "fld_emp_name",
      fieldKey: "employee_name",
      fieldType: "text.single_line",
      label: "Employee",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_emp_salary",
      fieldKey: "salary",
      fieldType: "number.decimal",
      label: "Salary",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_deal_name",
      fieldKey: "deal_name",
      fieldType: "text.single_line",
      label: "Deal",
      tableId: "tbl_2"
    });
    insertField(db, {
      fieldId: "fld_customer_note",
      fieldKey: "customer_note",
      fieldType: "text.long",
      label: "Customer Note",
      tableId: "tbl_2"
    });

    insertRecordProjection(db, {
      fields: {
        employee_name: "Alice",
        salary: "150000"
      },
      recordId: "rec_emp_1",
      recordKey: "employee-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        customer_note: "Churn risk",
        deal_name: "Renewal"
      },
      recordId: "rec_deal_1",
      recordKey: "deal-1",
      tableId: "tbl_2"
    });

    insertView(db, {
      sortFieldIds: ["fld_emp_salary"],
      tableId: "tbl_1",
      viewId: "view_employee_comp",
      viewKey: "employee-comp",
      viewName: "Employee Comp",
      visibleFieldIds: ["fld_emp_name", "fld_emp_salary"]
    });
    insertView(db, {
      sortFieldIds: ["fld_deal_name"],
      tableId: "tbl_2",
      viewId: "view_pipeline",
      viewKey: "pipeline",
      viewName: "Pipeline",
      visibleFieldIds: ["fld_deal_name", "fld_customer_note"]
    });

    insertPermissionSnapshot(db, {
      snapshotId: "snap_owner_tbl1",
      workspaceId: "ws_1",
      principalId: "usr_owner",
      policyRevision: 10,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_employee_comp",
      fields: {
        fld_emp_name: {
          agent: true,
          fieldId: "fld_emp_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_emp_salary: {
          agent: true,
          fieldId: "fld_emp_salary",
          fieldType: "number.decimal",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_member_tbl1",
      workspaceId: "ws_1",
      principalId: "usr_member",
      policyRevision: 11,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_employee_comp",
      fields: {
        fld_emp_name: {
          agent: true,
          fieldId: "fld_emp_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        },
        fld_emp_salary: {
          agent: false,
          fieldId: "fld_emp_salary",
          fieldType: "number.decimal",
          read: "hidden",
          workflow: false,
          write: false
        }
      }
    });
    insertPermissionSnapshot(db, {
      snapshotId: "snap_agent_tbl2",
      workspaceId: "ws_1",
      principalId: "agt_assist",
      policyRevision: 12,
      schemaEpoch: 1,
      scopeHash: "scope:view:view_pipeline",
      fields: {
        fld_customer_note: {
          agent: true,
          fieldId: "fld_customer_note",
          fieldType: "text.long",
          read: "redacted",
          workflow: true,
          write: false
        },
        fld_deal_name: {
          agent: true,
          fieldId: "fld_deal_name",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });

    const ownerRead = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_employee_comp?workspaceId=ws_1&principalId=usr_owner"),
      env,
      {} as ExecutionContext
    );
    const memberRead = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/views/view_employee_comp?workspaceId=ws_1&principalId=usr_member"),
      env,
      {} as ExecutionContext
    );
    const agentRead = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_2/views/view_pipeline?workspaceId=ws_1&principalId=agt_assist"),
      env,
      {} as ExecutionContext
    );

    const ownerBody = (await ownerRead.json()) as {
      rows: Array<{ cells: Record<string, unknown> }>;
      view: { allowed: boolean };
    };
    const memberBody = (await memberRead.json()) as {
      rows: unknown[];
      view: { allowed: boolean; blockedFieldIds: string[]; diagnostics: string[] };
    };
    const agentBody = (await agentRead.json()) as {
      rows: Array<{ cells: Record<string, unknown>; redactedFieldIds: string[] }>;
      view: { redactionApplied: boolean; redactedFieldIds: string[] };
    };

    expect(ownerBody.view.allowed).toBe(true);
    expect(ownerBody.rows[0]?.cells).toEqual({
      fld_emp_name: "Alice",
      fld_emp_salary: "150000"
    });

    expect(memberBody.view.allowed).toBe(false);
    expect(memberBody.view.blockedFieldIds).toEqual(["fld_emp_salary"]);
    expect(memberBody.view.diagnostics).toContain("view_constraint_hidden:fld_emp_salary");
    expect(memberBody.rows).toEqual([]);

    expect(agentBody.view).toMatchObject({
      redactionApplied: true,
      redactedFieldIds: ["fld_customer_note"]
    });
    expect(agentBody.rows[0]).toMatchObject({
      cells: {
        fld_customer_note: "[redacted]",
        fld_deal_name: "Renewal"
      },
      redactedFieldIds: ["fld_customer_note"]
    });
  });
});
