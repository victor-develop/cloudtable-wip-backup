import { afterEach, describe, expect, it, vi } from "vitest";

import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import { handleQueueBatch } from "../../../../src/queues/consumer";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
import { handleFetch } from "../../../../src/runtime/worker";
import {
  SqliteD1Database,
  seedAppAndTable,
  seedWorkspace
} from "../../harness/runtime/sqlite-d1";

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
  readonly sends: Array<{ message: CloudTableQueueMessage; options?: QueueSendOptions }> = [];

  async send(message: CloudTableQueueMessage, options?: QueueSendOptions): Promise<void> {
    this.sent.push(message);
    this.sends.push({ message, options });
  }
}

class FakeNamespace {
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

function createRouteBody(overrides: Partial<CommandEnvelope> = {}): Partial<CommandEnvelope> {
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
      "ws_1",
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

function insertRecord(
  db: SqliteD1Database,
  input: {
    archivedAt?: string | null;
    lastEventId?: string | null;
    recordId: string;
    recordKey: string;
    recordRevision?: number;
    tableId?: string;
  }
): void {
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
      "ws_1",
      input.tableId ?? "tbl_1",
      input.recordKey,
      input.recordRevision ?? 1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      input.archivedAt ?? null,
      input.lastEventId ?? null
    );
}

function insertRecordProjection(db: SqliteD1Database): void {
  insertRecord(db, {
    recordId: "rec_1",
    recordKey: "record-1"
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

function readCellRawValue(
  db: SqliteD1Database,
  input: {
    fieldId: string;
    recordId: string;
    tableId: string;
  }
): unknown {
  const row = db.inner
    .prepare(
      `SELECT value_json
       FROM cell_current
       WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
    )
    .get("ws_1", input.tableId, input.recordId, input.fieldId) as
    | { value_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  return (JSON.parse(row.value_json) as { raw?: unknown } | null)?.raw ?? null;
}

function readRecordProjectionFields(
  db: SqliteD1Database,
  input: {
    recordId: string;
    tableId: string;
  }
): Record<string, unknown> | null {
  const row = db.inner
    .prepare(
      `SELECT projection_json
       FROM record_projection
       WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
    )
    .get("ws_1", input.tableId, input.recordId) as
    | { projection_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  return (JSON.parse(row.projection_json) as { fields?: Record<string, unknown> } | null)?.fields ?? null;
}

function readEventMetadata(
  db: SqliteD1Database,
  input: {
    commandIdLike: string;
    tableId: string;
  }
): Record<string, unknown> | null {
  const row = db.inner
    .prepare(
      `SELECT metadata_json
       FROM event_ledger
       WHERE workspace_id = ? AND table_id = ? AND command_id LIKE ?
       ORDER BY workspace_sequence DESC
       LIMIT 1`
    )
    .get("ws_1", input.tableId, input.commandIdLike) as
    | { metadata_json: string }
    | undefined;

  if (!row) {
    return null;
  }

  return JSON.parse(row.metadata_json) as Record<string, unknown>;
}

function insertCellCurrent(
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

function insertPermissionSnapshot(
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
  }
): void {
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
      "ws_1",
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
      "ws_1",
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
        groupByFieldId: null,
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

function insertViewReadSnapshot(db: SqliteD1Database): void {
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
      "snap_view_processed",
      "ws_1",
      "usr_member",
      8,
      "scope:view:view_processed",
      JSON.stringify({
        snapshotId: "snap_view_processed",
        workspaceId: "ws_1",
        principalId: "usr_member",
        policyRevision: 8,
        schemaEpoch: 0,
        scopeHash: "scope:view:view_processed",
        fields: {
          fld_source: {
            agent: true,
            fieldId: "fld_source",
            fieldType: "text.single_line",
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
      }),
      "2026-06-06T00:00:00.000Z"
    );
}

function insertWorkflowDefinition(
  db: SqliteD1Database,
  input: {
    actions?: Array<Record<string, unknown>>;
    conditions?: Array<Record<string, unknown>>;
    definitionJson?: string;
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
      input.definitionJson ??
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

function insertEventLedgerEntry(
  db: SqliteD1Database,
  input: {
    aggregateId?: string | null;
    commandId: string;
    createdAt?: string;
    eventId: string;
    eventType: string;
    metadata?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    tableId?: string | null;
    tableSequence?: number | null;
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
      "ws_1",
      input.tableId ?? null,
      input.eventType,
      input.commandId,
      input.aggregateId ?? null,
      input.workspaceSequence,
      input.tableSequence ?? null,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.metadata ?? {}),
      input.createdAt ?? "2026-06-06T00:00:00.000Z"
    );
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
  const workflowDispatchQueue = new FakeQueue();
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
    aggregateQueue,
    db,
    deadLetterQueue,
    env,
    eventFanoutQueue,
    projectionQueue,
    workflowDispatchQueue,
    workflowStepQueue
  };
}

function createBatch(
  messages: CloudTableQueueMessage[]
): {
  acked: number;
  batch: {
    messages: Array<{
      ack(): void;
      body: CloudTableQueueMessage;
      retry(): void;
    }>;
  };
} {
  let acked = 0;

  return {
    get acked() {
      return acked;
    },
    batch: {
      messages: messages.map((body) => ({
        ack() {
          acked += 1;
        },
        body,
        retry() {
          throw new Error(`Unexpected retry for ${body.kind}`);
        }
      }))
    }
  };
}

function createBatchWithRetryTracking(
  messages: CloudTableQueueMessage[]
): {
  retried: number;
  batch: {
    messages: Array<{
      ack(): void;
      body: CloudTableQueueMessage;
      retry(): void;
    }>;
  };
} {
  let retried = 0;

  return {
    get retried() {
      return retried;
    },
    batch: {
      messages: messages.map((body) => ({
        ack() {},
        body,
        retry() {
          retried += 1;
        }
      }))
    }
  };
}

describe("workflow queue consumer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("executes only published workflows created through the command ingress and stops after pause", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);

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
                  principalId: "wf_service",
                  policyRevision: 7,
                  schemaEpoch: 0,
                  scopeHash: "scope:wf:status-sync"
                },
                trigger: {
                  operatorId: "field_changed",
                  match: {
                    fieldId: "fld_source",
                    fromWorkflow: false,
                    tableId: "tbl_1"
                  }
                },
                workflowId: "wf_status_sync"
              },
              name: "Status Sync",
              workflowId: "wf_status_sync",
              workflowKey: "status-sync"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createWorkflow.status).toBe(200);
    expect((await createWorkflow.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: []
      }
    });

    const publishWorkflow = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_status_sync/publish", {
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
    expect((await publishWorkflow.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: []
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_publish_1",
            idempotencyKey: "idem_trigger_publish_1",
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
    expect((await response.json()) as { result: { accepted: boolean } }).toMatchObject({
      result: {
        accepted: true
      }
    });

    const firstFanoutBatch = createBatch([eventFanoutQueue.sent.at(-1)!]);
    await handleQueueBatch(firstFanoutBatch.batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);

    const firstRunCount = await db
      .prepare(`SELECT COUNT(*) AS count FROM workflow_runs WHERE workflow_id = ?`)
      .bind("wf_status_sync")
      .first<{ count: number }>();
    expect(firstRunCount?.count).toBe(1);

    const pauseWorkflow = await handleFetch(
      new Request("https://example.test/v1/workflows/wf_status_sync/pause", {
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
    expect((await pauseWorkflow.json()) as { result: { accepted: boolean; diagnostics: string[] } }).toMatchObject({
      result: {
        accepted: true,
        diagnostics: []
      }
    });

    const secondTrigger = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_pause_1",
            idempotencyKey: "idem_trigger_pause_1",
            payload: {
              fieldType: "text.single_line",
              value: "ops"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(secondTrigger.status).toBe(200);
    expect((await secondTrigger.json()) as { result: { accepted: boolean } }).toMatchObject({
      result: {
        accepted: true
      }
    });

    const dispatchCountBefore = workflowDispatchQueue.sent.length;
    const stepCountBefore = workflowStepQueue.sent.length;
    await handleQueueBatch(createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);
    expect(workflowDispatchQueue.sent).toHaveLength(dispatchCountBefore + 1);
    await handleQueueBatch(
      createBatch([workflowDispatchQueue.sent.at(-1)!]).batch as never,
      env,
      {} as ExecutionContext
    );
    expect(workflowStepQueue.sent).toHaveLength(stepCountBefore);
  });

  it("starts a published manual workflow through the workflow-step queue", async () => {
    const { db, env, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "set_cell",
          input: {
            fieldId: "fld_status",
            fieldType: "text.single_line",
            recordId: "rec_1",
            tableId: "tbl_1",
            value: "manual"
          }
        }
      ],
      trigger: {
        operatorId: "manual"
      }
    });

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
        "evt_workflow_manual_1",
        "ws_1",
        null,
        "workflow.manual",
        "cmd_workflow_manual_1",
        "wf_status_sync",
        1,
        null,
        JSON.stringify({
          input: {
            source: "operator"
          },
          manualInvocationId: "idem_workflow_manual_1",
          workflowId: "wf_status_sync"
        }),
        JSON.stringify({
          actor: {
            mode: "user",
            principalId: "principal_1"
          },
          commandType: "workflow.manual",
          permissionScopeHash: "scope:workspace",
          permissionsVersion: 3,
          schemaEpoch: 0,
          scope: "workflow"
        }),
        "2026-06-06T00:00:00.000Z"
      );

    await handleQueueBatch(
      createBatch([
        {
          kind: "workflow-dispatch",
          eventId: "evt_workflow_manual_1",
          payload: {
            eventId: "evt_workflow_manual_1"
          },
          workspaceId: "ws_1"
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );
    expect(workflowDispatchQueue.sent).toHaveLength(0);
    expect(workflowStepQueue.sent).toHaveLength(1);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(
        `SELECT id, manual_invocation_id, status
         FROM workflow_runs
         WHERE workflow_id = ?`
      )
      .bind("wf_status_sync")
      .first<{ id: string; manual_invocation_id: string | null; status: string }>();
    expect(workflowRun).toEqual({
      id: "wfr:wf_status_sync:manual:idem_workflow_manual_1",
      manual_invocation_id: "idem_workflow_manual_1",
      status: "completed"
    });

    const statusCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_1", "rec_1", "fld_status")
      .first<{ value_json: string }>();
    expect(JSON.parse(statusCell?.value_json ?? "{}")).toMatchObject({
      raw: "manual"
    });
  });

  it("hydrates related-table resolver context for published cross-table workflow actions", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

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
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
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
        targetTableId: "tbl_dest"
      }
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });

    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: ["rec_dest_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["cell.set"],
      fields: {
        fld_owner_status: {
          agent: false,
          fieldId: "fld_owner_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "set_cell",
          input: {
            fieldId: {
              path: "relatedTables.destination.row.fields.owner_status.fieldId"
            },
            fieldType: {
              path: "relatedTables.destination.row.fields.owner_status.fieldType"
            },
            recordId: {
              path: "relatedTables.destination.row.recordId"
            },
            tableId: {
              path: "relatedTables.destination.tableId"
            },
            value: {
              path: "cell.value"
            }
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destination",
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      trigger: {
        operatorId: "field_changed",
        match: {
          fieldId: "fld_source",
          fromWorkflow: false,
          tableId: "tbl_1"
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_related_1",
            idempotencyKey: "idem_trigger_related_1",
            payload: {
              fieldType: "text.single_line",
              value: "approved"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);
    expect(workflowDispatchQueue.sent).toHaveLength(1);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    expect(workflowStepQueue.sent).toHaveLength(1);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const destinationCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_dest", "rec_dest_1", "fld_owner_status")
      .first<{ value_json: string }>();
    expect(JSON.parse(destinationCell?.value_json ?? "{}")).toMatchObject({
      raw: "approved"
    });
  });

  it("syncs a source field into a single-related target row through the first-class sync action", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
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
        targetTableId: "tbl_dest"
      }
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: ["rec_dest_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["cell.set"],
      fields: {
        fld_owner_status: {
          agent: false,
          fieldId: "fld_owner_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destination",
            sourceFieldId: "fld_source",
            targetFieldId: "fld_owner_status"
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destination",
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      trigger: {
        operatorId: "field_changed",
        match: {
          fieldId: "fld_source",
          fromWorkflow: false,
          tableId: "tbl_1"
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_related_sync_single",
            idempotencyKey: "idem_trigger_related_sync_single",
            payload: {
              fieldType: "text.single_line",
              value: "approved"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const destinationCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_dest", "rec_dest_1", "fld_owner_status")
      .first<{ value_json: string }>();
    expect(JSON.parse(destinationCell?.value_json ?? "{}")).toMatchObject({
      raw: "approved"
    });
  });

  it("syncs a source field into every value-matched target row through the first-class sync action", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_dest"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_dest_2",
      recordKey: "dest-2",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_dest_3",
      recordKey: "dest-3",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_2",
      tableId: "tbl_dest",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_3",
      tableId: "tbl_dest",
      value: "emea"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_2",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_3",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["cell.set"],
      fields: {
        fld_owner_status: {
          agent: false,
          fieldId: "fld_owner_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destinations_by_region",
            sourceFieldId: "fld_source",
            targetFieldId: "fld_owner_status"
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destinations_by_region",
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      trigger: {
        operatorId: "field_changed",
        match: {
          fieldId: "fld_source",
          fromWorkflow: false,
          tableId: "tbl_1"
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_related_sync_value_match",
            idempotencyKey: "idem_trigger_related_sync_value_match",
            payload: {
              fieldType: "text.single_line",
              value: "approved"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent.at(-1)!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const syncedRows = await db
      .prepare(
        `SELECT record_id, value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND field_id = ?
         ORDER BY record_id ASC`
      )
      .bind("ws_1", "tbl_dest", "fld_owner_status")
      .all<{ record_id: string; value_json: string }>();
    expect((syncedRows.results ?? []).map((row) => ({
      raw: (JSON.parse(row.value_json) as { raw?: unknown }).raw,
      recordId: row.record_id
    }))).toEqual([
      { raw: "approved", recordId: "rec_dest_1" },
      { raw: "approved", recordId: "rec_dest_2" },
      { raw: "pending", recordId: "rec_dest_3" }
    ]);
  });

  it("keeps first-class sync action replay idempotent across duplicate delivery", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
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
        targetTableId: "tbl_dest"
      }
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: ["rec_dest_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "pending"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["cell.set"],
      fields: {
        fld_owner_status: {
          agent: false,
          fieldId: "fld_owner_status",
          fieldType: "text.single_line",
          read: "visible",
          workflow: true,
          write: true
        }
      }
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destination",
            sourceFieldId: "fld_source",
            targetFieldId: "fld_owner_status"
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destination",
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      trigger: {
        operatorId: "field_changed",
        match: {
          fieldId: "fld_source",
          fromWorkflow: false,
          tableId: "tbl_1"
        }
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_related_sync_replay",
            idempotencyKey: "idem_trigger_related_sync_replay",
            payload: {
              fieldType: "text.single_line",
              value: "approved"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);
    expect(eventFanoutQueue.sent).toHaveLength(1);

    const triggerEventId = eventFanoutQueue.sent[0]?.eventId as string;
    const workflowRunId = `wfr:wf_status_sync:${triggerEventId}`;
    const workflowCommandId = `${workflowRunId}:action:0:rec_dest_1`;

    const fanoutBatch = createBatch([eventFanoutQueue.sent[0]!]);
    await handleQueueBatch(fanoutBatch.batch as never, env, {} as ExecutionContext);

    const dispatchBatch = createBatch([workflowDispatchQueue.sent[0]!, workflowDispatchQueue.sent[0]!]);
    await handleQueueBatch(dispatchBatch.batch as never, env, {} as ExecutionContext);
    expect(workflowStepQueue.sent).toHaveLength(1);

    const stepBatch = createBatch([workflowStepQueue.sent[0]!, workflowStepQueue.sent[0]!]);
    await handleQueueBatch(stepBatch.batch as never, env, {} as ExecutionContext);

    const workflowRuns = await db
      .prepare(
        `SELECT id, status
         FROM workflow_runs
         ORDER BY id ASC`
      )
      .bind()
      .all<{ id: string; status: string }>();
    expect(workflowRuns.results).toEqual([
      {
        id: workflowRunId,
        status: "completed"
      }
    ]);

    const workflowMutationEvents = await db
      .prepare(
        `SELECT event_id
         FROM event_ledger
         WHERE command_id = ?
         ORDER BY event_id ASC`
      )
      .bind(workflowCommandId)
      .all<{ event_id: string }>();
    expect(workflowMutationEvents.results).toHaveLength(1);
  });

  it("executes single-relation sync maintenance backfill and recompute through the coordinator-owned cell writer", async () => {
    const { db, env } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
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
        targetTableId: "tbl_dest"
      }
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: ["rec_dest_1"]
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "draft"
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destination",
            sourceFieldId: "fld_source",
            targetFieldId: "fld_owner_status"
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destination",
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      workflowId: "wf_sync_single",
      workflowVersionId: "wf_sync_single:v1"
    });

    const syncMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        sync: {
          alias: "destination:fld_source:fld_owner_status",
          dependencyFieldIds: ["fld_account", "fld_source"],
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_dest"
          },
          sourceFieldId: "fld_source",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_owner_status",
          targetTableId: "tbl_dest"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_sync_single",
        workflowVersionId: "wf_sync_single:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([syncMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_owner_status",
      recordId: "rec_dest_1",
      tableId: "tbl_dest"
    })).toBe("pending");
    expect(
      readEventMetadata(db, {
        commandIdLike: "cmd:sync-maintenance:%",
        tableId: "tbl_dest"
      })
    ).toMatchObject({
      actor: {
        mode: "workflow",
        principalId: "wf_service"
      },
      coordinatorOwnedMutation: true,
      permissionScopeHash: "scope:wf:status-sync",
      permissionsVersion: 7,
      schemaEpoch: 0,
      scope: "table"
    });

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: "approved",
          valueType: "text.single_line",
          version: 1
        }),
        "approved",
        "approved",
        JSON.stringify("approved"),
        "evt_seed_sync_source_update",
        "ws_1",
        "tbl_1",
        "rec_1",
        "fld_source"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...syncMessage,
          eventId: "evt_sync_single_recompute",
          payload: {
            ...syncMessage.payload,
            trigger: {
              changedFieldIds: ["fld_source"],
              eventId: "evt_sync_single_recompute",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_1"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_owner_status",
      recordId: "rec_dest_1",
      tableId: "tbl_dest"
    })).toBe("approved");
  });

  it("executes value-matched sync maintenance backfill and recompute for matched target rows", async () => {
    const { db, env } = createEnv();

    db.inner
      .prepare(
        `INSERT INTO tables (
           id, workspace_id, app_id, slug, name, schema_epoch, current_schema_version,
           created_at, updated_at, archived_at, last_event_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "tbl_dest",
        "ws_1",
        "app_1",
        "table-dest",
        "Destination Table",
        0,
        1,
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
    insertField(db, {
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_dest"
    });
    insertField(db, {
      fieldId: "fld_owner_status",
      fieldKey: "owner_status",
      fieldType: "text.single_line",
      label: "Owner Status",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_1",
      recordKey: "record-1",
      tableId: "tbl_1"
    });
    insertRecord(db, {
      recordId: "rec_dest_1",
      recordKey: "dest-1",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_dest_2",
      recordKey: "dest-2",
      tableId: "tbl_dest"
    });
    insertRecord(db, {
      recordId: "rec_dest_3",
      recordKey: "dest-3",
      tableId: "tbl_dest"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_source",
      fieldType: "text.single_line",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "pending"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_2",
      tableId: "tbl_dest",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_dest_3",
      tableId: "tbl_dest",
      value: "emea"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_1",
      tableId: "tbl_dest",
      value: "draft"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_2",
      tableId: "tbl_dest",
      value: "draft"
    });
    insertCellCurrent(db, {
      fieldId: "fld_owner_status",
      fieldType: "text.single_line",
      recordId: "rec_dest_3",
      tableId: "tbl_dest",
      value: "draft"
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destinations_by_region",
            sourceFieldId: "fld_source",
            targetFieldId: "fld_owner_status"
          }
        }
      ],
      metadata: {
        relatedTableResolvers: [
          {
            alias: "destinations_by_region",
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_dest"
          }
        ],
        status: "published",
        tableId: "tbl_1"
      },
      workflowId: "wf_sync_region",
      workflowVersionId: "wf_sync_region:v1"
    });

    const syncMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        sync: {
          alias: "destinations_by_region:fld_source:fld_owner_status",
          dependencyFieldIds: ["fld_region", "fld_source"],
          resolver: {
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_dest"
          },
          sourceFieldId: "fld_source",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_owner_status",
          targetTableId: "tbl_dest"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_sync_region",
        workflowVersionId: "wf_sync_region:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([syncMessage]).batch as never, env, {} as ExecutionContext);

    expect((["rec_dest_1", "rec_dest_2", "rec_dest_3"] as const).map((recordId) => ({
      recordId,
      value: readCellRawValue(db, {
        fieldId: "fld_owner_status",
        recordId,
        tableId: "tbl_dest"
      })
    }))).toEqual([
      { recordId: "rec_dest_1", value: "pending" },
      { recordId: "rec_dest_2", value: "pending" },
      { recordId: "rec_dest_3", value: "draft" }
    ]);

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: "approved",
          valueType: "text.single_line",
          version: 1
        }),
        "approved",
        "approved",
        JSON.stringify("approved"),
        "evt_seed_sync_region_update",
        "ws_1",
        "tbl_1",
        "rec_1",
        "fld_source"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...syncMessage,
          eventId: "evt_sync_region_recompute",
          payload: {
            ...syncMessage.payload,
            trigger: {
              changedFieldIds: ["fld_source"],
              eventId: "evt_sync_region_recompute",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_1"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect((["rec_dest_1", "rec_dest_2", "rec_dest_3"] as const).map((recordId) => ({
      recordId,
      value: readCellRawValue(db, {
        fieldId: "fld_owner_status",
        recordId,
        tableId: "tbl_dest"
      })
    }))).toEqual([
      { recordId: "rec_dest_1", value: "approved" },
      { recordId: "rec_dest_2", value: "approved" },
      { recordId: "rec_dest_3", value: "draft" }
    ]);
  });

  it("creates one workflow run and one workflow mutation across duplicate delivery", async () => {
    const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
      createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertWorkflowDefinition(db);

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_1",
            idempotencyKey: "idem_trigger_1",
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
    expect(eventFanoutQueue.sent).toHaveLength(1);

    const triggerEventId = eventFanoutQueue.sent[0]?.eventId as string;
    const workflowRunId = `wfr:wf_status_sync:${triggerEventId}`;
    const workflowCommandId = `${workflowRunId}:action:0`;

    const fanoutBatch = createBatch([eventFanoutQueue.sent[0]!]);
    await handleQueueBatch(fanoutBatch.batch as never, env, {} as ExecutionContext);
    expect(fanoutBatch.acked).toBe(1);
    expect(workflowDispatchQueue.sent).toHaveLength(1);
    expect(projectionQueue.sent).toHaveLength(1);

    const dispatchBatch = createBatch([workflowDispatchQueue.sent[0]!, workflowDispatchQueue.sent[0]!]);
    await handleQueueBatch(dispatchBatch.batch as never, env, {} as ExecutionContext);
    expect(dispatchBatch.acked).toBe(2);
    expect(workflowStepQueue.sent).toHaveLength(1);

    const stepBatch = createBatch([workflowStepQueue.sent[0]!, workflowStepQueue.sent[0]!]);
    await handleQueueBatch(stepBatch.batch as never, env, {} as ExecutionContext);
    expect(stepBatch.acked).toBe(2);

    const workflowRuns = await db
      .prepare(
        `SELECT id, status, principal_id
         FROM workflow_runs
         ORDER BY id ASC`
      )
      .bind()
      .all<{ id: string; principal_id: string; status: string }>();
    expect(workflowRuns.results).toEqual([
      {
        id: workflowRunId,
        principal_id: "wf_service",
        status: "completed"
      }
    ]);

    const workflowSteps = await db
      .prepare(
        `SELECT id, status, step_key, attempt_count
         FROM workflow_run_steps
         ORDER BY id ASC`
      )
      .bind()
      .all<{ attempt_count: number; id: string; status: string; step_key: string }>();
    expect(workflowSteps.results).toEqual([
      {
        attempt_count: 1,
        id: `${workflowRunId}:step:0`,
        status: "completed",
        step_key: "action:0"
      }
    ]);

    const statusCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_1", "rec_1", "fld_status")
      .first<{ value_json: string }>();
    expect(statusCell).not.toBeNull();
    expect(JSON.parse(statusCell?.value_json ?? "{}")).toMatchObject({
      raw: "processed"
    });

    const workflowCommandRows = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM event_ledger
         WHERE command_id = ?`
      )
      .bind(workflowCommandId)
      .first<{ count: number }>();
    expect(workflowCommandRows?.count).toBe(1);
  });

  it("creates one scheduled workflow run across duplicate scheduler dispatch delivery", async () => {
    const { db, env, workflowStepQueue } = createEnv();

    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "emit_notification_event",
          input: {
            channel: "ops",
            message: "cadenced dispatch"
          }
        }
      ],
      principal: {
        principalId: "wf_scheduler",
        policyRevision: 7,
        schemaEpoch: 0,
        scopeHash: "scope:wf:status-sync"
      },
      trigger: {
        operatorId: "scheduled",
        match: {
          schedule: {
            cadenceMinutes: 5
          }
        }
      }
    });

    const scheduledDispatch = {
      kind: "workflow-dispatch",
      payload: {
        cadenceMinutes: 5,
        scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
        scheduleWindowStart: "2026-06-06T00:05:00.000Z",
        scheduledAt: "2026-06-06T00:10:00.000Z",
        triggerKind: "scheduled",
        workflowId: "wf_status_sync",
        workflowVersionId: "wf_status_sync:v1"
      },
      workspaceId: "ws_1"
    } satisfies CloudTableQueueMessage;

    const dispatchBatch = createBatch([scheduledDispatch, scheduledDispatch]);
    await handleQueueBatch(dispatchBatch.batch as never, env, {} as ExecutionContext);

    expect(dispatchBatch.acked).toBe(2);
    expect(workflowStepQueue.sent).toHaveLength(1);

    const workflowRun = await db
      .prepare(
        `SELECT id, trigger_event_id, state_json, status
         FROM workflow_runs
         WHERE workflow_id = ?`
      )
      .bind("wf_status_sync")
      .first<{
        id: string;
        state_json: string;
        status: string;
        trigger_event_id: string;
      }>();
    expect(workflowRun).toEqual({
      id: "wfr:wf_status_sync:schedule:wf_status_sync:v1:2026-06-06T00:05:00.000Z",
      state_json: JSON.stringify({
        cadenceMinutes: 5,
        principalId: "wf_scheduler",
        scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
        scheduleWindowStart: "2026-06-06T00:05:00.000Z",
        scheduledAt: "2026-06-06T00:10:00.000Z",
        triggerEventId: "evt:wf_status_sync:v1:schedule:2026-06-06T00:05:00.000Z"
      }),
      status: "queued",
      trigger_event_id: "evt:wf_status_sync:v1:schedule:2026-06-06T00:05:00.000Z"
    });

    const scheduledEvent = await db
      .prepare(
        `SELECT event_type, payload_json
         FROM event_ledger
         WHERE event_id = ?`
      )
      .bind("evt:wf_status_sync:v1:schedule:2026-06-06T00:05:00.000Z")
      .first<{ event_type: string; payload_json: string }>();
    expect(scheduledEvent?.event_type).toBe("workflow.scheduled");
    expect(JSON.parse(scheduledEvent?.payload_json ?? "{}")).toEqual({
      cadenceMinutes: 5,
      scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
      scheduleWindowStart: "2026-06-06T00:05:00.000Z",
      scheduledAt: "2026-06-06T00:10:00.000Z",
      workflowId: "wf_status_sync",
      workflowVersionId: "wf_status_sync:v1"
    });
  });

  it("re-resolves the latest workflow principal snapshot before executing a step", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      policyRevision: 7
    });
    insertPermissionSnapshot(db, {
      policyRevision: 8
    });
    insertWorkflowDefinition(db);

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_reresolve_1",
            idempotencyKey: "idem_trigger_reresolve_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(
        `SELECT id, status
         FROM workflow_runs
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowEvent = await db
      .prepare(
        `SELECT metadata_json
         FROM event_ledger
         WHERE command_id = ?
         LIMIT 1`
      )
      .bind(`${workflowRun?.id}:action:0`)
      .first<{ metadata_json: string }>();
    expect(workflowEvent).not.toBeNull();
    expect(
      JSON.parse(workflowEvent?.metadata_json ?? "{}") as {
        permissionsVersion?: number;
      }
    ).toMatchObject({
      permissionsVersion: 8
    });
  });

  it("fails the workflow step when the latest workflow principal snapshot revokes access", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      policyRevision: 7,
      workflow: true,
      write: true
    });
    insertPermissionSnapshot(db, {
      policyRevision: 8,
      workflow: false,
      write: false
    });
    insertWorkflowDefinition(db);

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_revoked_1",
            idempotencyKey: "idem_trigger_revoked_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(
        `SELECT id, status
         FROM workflow_runs
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("failed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; status: string }>();
    expect(workflowStep).toMatchObject({
      last_error_code: "field_read_only:fld_status",
      status: "failed"
    });

    const statusCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_1", "rec_1", "fld_status")
      .first<{ value_json: string }>();
    expect(statusCell).toBeNull();
  });

  it("persists replayable dead letters for non-permission workflow step failures", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "set_cell",
          input: {
            fieldId: "fld_status",
            fieldType: "text.single_line",
            recordId: "rec_missing",
            tableId: "tbl_1",
            value: "processed"
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
          createRouteBody({
            commandId: "cmd_trigger_dead_letter_1",
            idempotencyKey: "idem_trigger_dead_letter_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(
        `SELECT id, status, dead_lettered_at
         FROM workflow_runs
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ dead_lettered_at: string | null; id: string; status: string }>();
    expect(workflowRun?.status).toBe("dead_lettered");
    expect(workflowRun?.dead_lettered_at).not.toBeNull();

    const workflowStep = await db
      .prepare(
        `SELECT id, status, last_error_code, attempt_count
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{
        attempt_count: number;
        id: string;
        last_error_code: string | null;
        status: string;
      }>();
    expect(workflowStep).toMatchObject({
      attempt_count: 1,
      last_error_code: "record_not_found:rec_missing",
      status: "dead_lettered"
    });

    const deadLetter = await db
      .prepare(
        `SELECT
           id,
           workflow_run_id,
           workspace_id,
           queue_name,
           payload_json,
           failure_code,
           failure_message,
           attempt_count
         FROM workflow_dead_letters
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{
        attempt_count: number;
        failure_code: string;
        failure_message: string;
        id: string;
        payload_json: string;
        queue_name: string;
        workflow_run_id: string;
        workspace_id: string;
      }>();
    expect(deadLetter).toMatchObject({
      attempt_count: 1,
      failure_code: "record_not_found:rec_missing",
      failure_message: "record_not_found:rec_missing",
      id: `wdl:${workflowStep?.id}`,
      queue_name: "workflow-step",
      workflow_run_id: workflowRun?.id,
      workspace_id: "ws_1"
    });
    expect(JSON.parse(deadLetter?.payload_json ?? "{}")).toMatchObject({
      sourceMessage: {
        kind: "workflow-step",
        payload: {
          workflowStepId: workflowStep?.id
        },
        workflowRunId: workflowRun?.id,
        workspaceId: "ws_1"
      },
      workflowRunId: workflowRun?.id,
      workflowStepId: workflowStep?.id
    });
  });

  it("replays eligible workflow dead letters through the reprocessor queue once", async () => {
    const {
      db,
      deadLetterQueue,
      env,
      eventFanoutQueue,
      workflowDispatchQueue,
      workflowStepQueue
    } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "set_cell",
          input: {
            fieldId: "fld_status",
            fieldType: "text.single_line",
            recordId: "rec_missing",
            tableId: "tbl_1",
            value: "processed"
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
          createRouteBody({
            commandId: "cmd_trigger_dead_letter_replay_1",
            idempotencyKey: "idem_trigger_dead_letter_replay_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string }>();
    const workflowStep = await db
      .prepare(`SELECT id FROM workflow_run_steps ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string }>();
    expect(workflowRun).not.toBeNull();
    expect(workflowStep).not.toBeNull();
    const deadLetterId = `wdl:${workflowStep?.id}`;

    insertRecord(db, {
      recordId: "rec_missing",
      recordKey: "record-missing"
    });

    deadLetterQueue.sent.push({
      kind: "dead-letter-reprocessor",
      payload: {
        deadLetterId
      },
      workspaceId: "ws_1"
    });

    const stepQueueCountBeforeReplay = workflowStepQueue.sent.length;
    await handleQueueBatch(createBatch([deadLetterQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    expect(workflowStepQueue.sent).toHaveLength(stepQueueCountBeforeReplay + 1);

    await handleQueueBatch(createBatch([deadLetterQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    expect(workflowStepQueue.sent).toHaveLength(stepQueueCountBeforeReplay + 1);

    await handleQueueBatch(
      createBatch([workflowStepQueue.sent.at(-1)!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const replayedRun = await db
      .prepare(
        `SELECT status, dead_lettered_at, attempt_count
         FROM workflow_runs
         WHERE id = ?`
      )
      .bind(workflowRun!.id)
      .first<{ attempt_count: number; dead_lettered_at: string | null; status: string }>();
    expect(replayedRun).toMatchObject({
      attempt_count: 2,
      dead_lettered_at: null,
      status: "completed"
    });

    const replayedStep = await db
      .prepare(
        `SELECT status, last_error_code, attempt_count
         FROM workflow_run_steps
         WHERE id = ?`
      )
      .bind(workflowStep!.id)
      .first<{ attempt_count: number; last_error_code: string | null; status: string }>();
    expect(replayedStep).toMatchObject({
      attempt_count: 2,
      last_error_code: null,
      status: "completed"
    });

    const statusCell = await db
      .prepare(
        `SELECT value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_1", "rec_missing", "fld_status")
      .first<{ value_json: string }>();
    expect(JSON.parse(statusCell?.value_json ?? "{}")).toMatchObject({
      raw: "processed"
    });
  });

  it("makes workflow-originated record mutations visible to saved view filters", async () => {
    const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
      createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertViewReadSnapshot(db);
    insertWorkflowDefinition(db);
    insertView(db, {
      filterFieldIds: ["fld_status"],
      tableId: "tbl_1",
      viewId: "view_processed",
      viewKey: "processed",
      viewName: "Processed",
      visibleFieldIds: ["fld_source"]
    });

    const before = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_processed?workspaceId=ws_1&principalId=usr_member&policyRevision=8&permissionScopeHash=scope:view:view_processed"
      ),
      env,
      {} as ExecutionContext
    );
    const beforeBody = (await before.json()) as {
      rows: Array<{ recordId: string }>;
    };
    expect(beforeBody.rows).toEqual([]);

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_view_1",
            idempotencyKey: "idem_trigger_view_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([eventFanoutQueue.sent[1]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([projectionQueue.sent[1]!]).batch as never, env, {} as ExecutionContext);

    const after = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_processed?workspaceId=ws_1&principalId=usr_member&policyRevision=8&permissionScopeHash=scope:view:view_processed"
      ),
      env,
      {} as ExecutionContext
    );
    const afterBody = (await after.json()) as {
      rows: Array<{ recordId: string; cells: Record<string, unknown> }>;
    };

    expect(afterBody.rows).toEqual([
      {
        cells: {
          fld_source: "crm"
        },
        recordId: "rec_1",
        recordKey: "record-1",
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: {
          fld_source: "visible"
        }
      }
    ]);
  });

  it("rebuilds field index entries from direct writes and ignores duplicate deliveries", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertView(db, {
      filterFieldIds: ["fld_status"],
      sortFieldIds: ["fld_status"],
      tableId: "tbl_1",
      viewId: "view_status",
      viewKey: "status",
      viewName: "Status",
      visibleFieldIds: ["fld_status"]
    });

    const response = await handleFetch(
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
              fieldType: "text.single_line",
              value: "processed"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    expect(projectionQueue.sent).toHaveLength(1);

    await handleQueueBatch(
      createBatch([projectionQueue.sent[0]!, projectionQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const indexRows = await db
      .prepare(
        `SELECT
           field_id,
           record_id,
           index_value_text,
           index_value_number,
           index_value_datetime,
           index_value_bool,
           last_event_id
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ?
         ORDER BY field_id ASC, record_id ASC`
      )
      .bind("ws_1", "tbl_1")
      .all<{
        field_id: string;
        index_value_bool: number | null;
        index_value_datetime: string | null;
        index_value_number: number | null;
        index_value_text: string | null;
        last_event_id: string;
        record_id: string;
      }>();

    expect(indexRows.results).toEqual([
      {
        field_id: "fld_status",
        index_value_bool: null,
        index_value_datetime: null,
        index_value_number: null,
        index_value_text: "processed",
        last_event_id: eventFanoutQueue.sent[0]?.eventId as string,
        record_id: "rec_1"
      }
    ]);
  });

  it("rebuilds configured status indexes with label search text and option-order sorting", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

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
    insertRecordProjection(db);
    insertView(db, {
      filterFieldIds: ["fld_status"],
      sortFieldIds: ["fld_status"],
      tableId: "tbl_1",
      viewId: "view_status_semantic",
      viewKey: "status-semantic",
      viewName: "Status Semantic",
      visibleFieldIds: ["fld_status"]
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_status_semantic_1",
            idempotencyKey: "idem_status_semantic_1",
            payload: {
              fieldType: "status.semantic",
              value: "in_progress"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([projectionQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const indexRows = await db
      .prepare(
        `SELECT
           field_id,
           record_id,
           index_value_text,
           index_value_number,
           index_value_datetime,
           index_value_bool
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ?
         ORDER BY field_id ASC, record_id ASC`
      )
      .bind("ws_1", "tbl_1")
      .all<{
        field_id: string;
        index_value_bool: number | null;
        index_value_datetime: string | null;
        index_value_number: number | null;
        index_value_text: string | null;
        record_id: string;
      }>();

    expect(indexRows.results).toEqual([
      {
        field_id: "fld_status",
        index_value_bool: null,
        index_value_datetime: null,
        index_value_number: 1,
        index_value_text: "In Progress",
        record_id: "rec_1"
      }
    ]);
  });

  it("drops stale index maintenance and clears rows when a dependent field becomes empty", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertView(db, {
      filterFieldIds: ["fld_status"],
      tableId: "tbl_1",
      viewId: "view_status",
      viewKey: "status",
      viewName: "Status",
      visibleFieldIds: ["fld_status"]
    });

    const firstResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_status_2",
            idempotencyKey: "idem_status_2",
            payload: {
              fieldType: "text.single_line",
              value: "ready"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(firstResponse.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    const staleMessage = projectionQueue.sent[0]!;
    await handleQueueBatch(createBatch([staleMessage]).batch as never, env, {} as ExecutionContext);

    const secondResponse = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_status_3",
            idempotencyKey: "idem_status_3",
            payload: {
              fieldType: "text.single_line",
              value: ""
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(secondResponse.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[1]!]).batch as never, env, {} as ExecutionContext);
    const newestMessage = projectionQueue.sent[1]!;
    await handleQueueBatch(createBatch([newestMessage, staleMessage]).batch as never, env, {} as ExecutionContext);

    const indexRows = await db
      .prepare(
        `SELECT field_id, record_id
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ?`
      )
      .bind("ws_1", "tbl_1")
      .all<{ field_id: string; record_id: string }>();

    expect(indexRows.results).toEqual([]);
  });

  it("rebuilds dependent index entries for workflow-originated writes", async () => {
    const { db, env, eventFanoutQueue, projectionQueue, workflowDispatchQueue, workflowStepQueue } =
      createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db);
    insertWorkflowDefinition(db);
    insertView(db, {
      filterFieldIds: ["fld_status"],
      sortFieldIds: ["fld_status"],
      tableId: "tbl_1",
      viewId: "view_processed",
      viewKey: "processed",
      viewName: "Processed",
      visibleFieldIds: ["fld_source"]
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_status_workflow_1",
            idempotencyKey: "idem_status_workflow_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([eventFanoutQueue.sent[1]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([projectionQueue.sent[1]!]).batch as never, env, {} as ExecutionContext);

    const indexRow = await db
      .prepare(
        `SELECT field_id, record_id, index_value_text
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_1", "fld_status", "rec_1")
      .first<{ field_id: string; index_value_text: string | null; record_id: string }>();

    expect(indexRow).toEqual({
      field_id: "fld_status",
      index_value_text: "processed",
      record_id: "rec_1"
    });
  });

  it("delivers webhook workflow actions and records a completed step", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 202
      })
    );

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.webhook.enqueue"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "send_webhook",
          input: {
            body: {
              event: "record.updated",
              recordId: {
                path: "row.recordId"
              }
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
          createRouteBody({
            commandId: "cmd_trigger_webhook_1",
            idempotencyKey: "idem_trigger_webhook_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = fetchSpy.mock.calls[0] ?? [];
    expect(requestUrl).toBe("https://example.test/hooks/cloudtable");
    expect(requestInit).toMatchObject({
      method: "POST"
    });
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      event: "record.updated",
      recordId: "rec_1"
    });

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");
    expect(workflowRun?.id.startsWith("wfr:wf_status_sync:")).toBe(true);
    expect((requestInit?.headers as Headers).get("idempotency-key")).toBe(
      `${workflowRun?.id}:action:0`
    );

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code, output_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; output_json: string; status: string }>();
    expect(workflowStep?.status).toBe("completed");
    expect(workflowStep?.last_error_code).toBeNull();
    expect(JSON.parse(workflowStep?.output_json ?? "{}")).toMatchObject({
      accepted: true,
      diagnostics: []
    });
  });

  it("commits internal-job workflow actions through the command bus and publishes fan-out", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      commandTypes: ["job.enqueue"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "enqueue_internal_job",
          input: {
            args: {
              recordId: {
                path: "row.recordId"
              }
            },
            jobType: "projection.rebuild"
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
          createRouteBody({
            commandId: "cmd_trigger_job_1",
            idempotencyKey: "idem_trigger_job_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code, output_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; output_json: string; status: string }>();
    expect(workflowStep?.status).toBe("completed");
    expect(workflowStep?.last_error_code).toBeNull();
    const jobOutput = JSON.parse(workflowStep?.output_json ?? "{}") as {
      events?: Array<{ eventId?: string; commandType?: string; eventType?: string }>;
    };
    expect(jobOutput).toMatchObject({
      accepted: true,
      diagnostics: [],
      events: [
        {
          commandType: "job.enqueue",
          eventType: "job.enqueued"
        }
      ],
      sideEffects: [
        {
          queue: "event-fanout",
          reason: "job_enqueued_fanout"
        }
      ]
    });

    expect(workflowStepQueue.sent).toHaveLength(1);
    expect(eventFanoutQueue.sent).toHaveLength(2);
    expect(eventFanoutQueue.sent[1]).toMatchObject({
      eventId: jobOutput.events?.[0]?.eventId,
      kind: "event-fanout",
      workspaceId: "ws_1"
    });
  });

  it("commits notification workflow actions through the command bus and publishes fan-out", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "emit_notification_event",
          input: {
            channel: "activity",
            details: {
              recordId: {
                path: "row.recordId"
              }
            },
            message: "Workflow step completed."
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
          createRouteBody({
            commandId: "cmd_trigger_notification_1",
            idempotencyKey: "idem_trigger_notification_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code, output_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; output_json: string; status: string }>();
    expect(workflowStep?.status).toBe("completed");
    expect(workflowStep?.last_error_code).toBeNull();
    const notificationOutput = JSON.parse(workflowStep?.output_json ?? "{}") as {
      events?: Array<{ eventId?: string; commandType?: string; eventType?: string }>;
    };
    expect(notificationOutput).toMatchObject({
      accepted: true,
      diagnostics: [],
      events: [
        {
          commandType: "notification.emit",
          eventType: "notification.emitted"
        }
      ],
      sideEffects: [
        {
          queue: "event-fanout",
          reason: "notification_emitted_fanout"
        }
      ]
    });

    expect(workflowStepQueue.sent).toHaveLength(1);
    expect(eventFanoutQueue.sent).toHaveLength(2);
    expect(eventFanoutQueue.sent[1]).toMatchObject({
      eventId: notificationOutput.events?.[0]?.eventId,
      kind: "event-fanout",
      workspaceId: "ws_1"
    });
  });

  it("routes aggregate recompute envelopes from record changes that hit aggregate dependencies", async () => {
    const {
      aggregateQueue,
      db,
      env,
      eventFanoutQueue,
      projectionQueue,
      workflowDispatchQueue
    } = createEnv();

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
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "text.single_line",
      label: "Status",
      tableId: "tbl_1"
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
    insertRecordProjection(db);
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "open_ticket_count",
            dependencyFieldIds: ["fld_status"],
            groupingSource: {
              kind: "related_record",
              resolverAlias: "account"
            },
            operationConfig: {
              includeArchived: false
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
      }
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_status", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_aggregate_recompute",
            idempotencyKey: "idem_trigger_aggregate_recompute",
            payload: {
              fieldType: "text.single_line",
              value: "open"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(workflowDispatchQueue.sent).toHaveLength(1);
    expect(projectionQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      workspaceId: "ws_1",
      payload: {
        aggregate: {
          alias: "open_ticket_count",
          dependencyFieldIds: ["fld_account", "fld_status"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account",
            sourceFieldId: "fld_account"
          },
          operationConfig: {
            includeArchived: false
          },
          operationId: "count_records",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.account",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_open_ticket_count",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          changedFieldIds: ["fld_status"],
          kind: "recompute"
        },
        workflowId: "wf_status_sync",
        workflowVersionId: "wf_status_sync:v1"
      }
    });
  });

  it("routes aggregate backfill envelopes when aggregate-enabled workflows publish", async () => {
    const { aggregateQueue, db, env, workflowDispatchQueue } = createEnv();

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
        dependsOnFieldIds: ["fld_account"],
        expression: "aggregate.account_open_ticket_count",
        resultValueType: "number"
      }
    });
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "open_ticket_count",
            dependencyFieldIds: ["fld_account"],
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
      }
    });
    insertEventLedgerEntry(db, {
      aggregateId: "wf_status_sync",
      commandId: "cmd_workflow_publish_aggregate",
      eventId: "evt_workflow_publish_aggregate",
      eventType: "workflow.published",
      metadata: {
        aggregateType: "workflow",
        commandType: "workflow.publish"
      },
      payload: {
        workflowId: "wf_status_sync"
      },
      workspaceSequence: 1
    });

    await handleQueueBatch(
      createBatch([
        {
          kind: "event-fanout",
          eventId: "evt_workflow_publish_aggregate",
          payload: {
            eventId: "evt_workflow_publish_aggregate"
          },
          workspaceId: "ws_1"
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(workflowDispatchQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      eventId: "evt_workflow_publish_aggregate",
      workspaceId: "ws_1",
      payload: {
        aggregate: {
          alias: "open_ticket_count",
          dependencyFieldIds: ["fld_account"],
          operationId: "count_records",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceTableId: "tbl_1",
          targetFieldId: "fld_open_ticket_count",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_status_sync",
        workflowVersionId: "wf_status_sync:v1"
      }
    });
  });

  it("routes sync backfill envelopes when sync-enabled workflows publish", async () => {
    const { aggregateQueue, db, env, workflowDispatchQueue } = createEnv();

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
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "sync_related_field",
          input: {
            resolverAlias: "destination",
            sourceFieldId: "fld_source_status",
            targetFieldId: "fld_account_status"
          }
        }
      ],
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
      workflowId: "wf_sync_publish",
      workflowVersionId: "wf_sync_publish:v1"
    });
    insertEventLedgerEntry(db, {
      aggregateId: "wf_sync_publish",
      commandId: "cmd_workflow_publish_sync",
      eventId: "evt_workflow_publish_sync",
      eventType: "workflow.published",
      metadata: {
        aggregateType: "workflow",
        commandType: "workflow.publish"
      },
      payload: {
        workflowId: "wf_sync_publish"
      },
      workspaceSequence: 1
    });

    await handleQueueBatch(
      createBatch([
        {
          kind: "event-fanout",
          eventId: "evt_workflow_publish_sync",
          payload: {
            eventId: "evt_workflow_publish_sync"
          },
          workspaceId: "ws_1"
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(workflowDispatchQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      eventId: "evt_workflow_publish_sync",
      workspaceId: "ws_1",
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
          reason: "workflow_published"
        },
        workflowId: "wf_sync_publish",
        workflowVersionId: "wf_sync_publish:v1"
      }
    });
  });

  it("routes lookup recompute envelopes for published single-relation workflows", async () => {
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
    insertRecordProjection(db);
    insertWorkflowDefinition(db, {
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
        status: "published",
        tableId: "tbl_1"
      },
      workflowId: "wf_ticket_lookup",
      workflowVersionId: "wf_ticket_lookup:v1"
    });

    insertEventLedgerEntry(db, {
      aggregateId: "rec_1",
      commandId: "cmd_trigger_lookup_recompute",
      eventId: "evt_trigger_lookup_recompute",
      eventType: "cell.set",
      metadata: {
        aggregateType: "record",
        commandType: "cell.set"
      },
      payload: {
        fieldId: "fld_account",
        fieldType: "relation.record",
        recordId: "rec_1",
        tableId: "tbl_1",
        value: "rec_account_1"
      },
      tableId: "tbl_1",
      workspaceSequence: 1
    });

    await handleQueueBatch(
      createBatch([
        {
          kind: "event-fanout",
          eventId: "evt_trigger_lookup_recompute",
          payload: {
            eventId: "evt_trigger_lookup_recompute"
          },
          workspaceId: "ws_1"
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      workspaceId: "ws_1",
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
          sourceRelationPath: "relatedTables.account_lookup",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_ticket_account_name",
          valueFieldId: "fld_account_name"
        },
        trigger: {
          changedFieldIds: ["fld_account"],
          kind: "recompute"
        }
      }
    });
  });

  it("executes lookup backfill and recompute for single-relation computed fields", async () => {
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
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_2",
      recordKey: "account-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account_name",
      fieldType: "text.single_line",
      recordId: "rec_account_1",
      tableId: "tbl_accounts",
      value: "Acme"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account_name",
      fieldType: "text.single_line",
      recordId: "rec_account_2",
      tableId: "tbl_accounts",
      value: "Globex"
    });
    insertWorkflowDefinition(db, {
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
        status: "published",
        tableId: "tbl_1"
      },
      workflowId: "wf_ticket_lookup",
      workflowVersionId: "wf_ticket_lookup:v1"
    });

    const lookupMessage: CloudTableQueueMessage = {
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
          sourceRelationPath: "relatedTables.account_lookup",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_ticket_account_name",
          valueFieldId: "fld_account_name"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_ticket_lookup",
        workflowVersionId: "wf_ticket_lookup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([lookupMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_account_name",
      recordId: "rec_ticket_1",
      tableId: "tbl_1"
    })).toBe("Acme");
    expect(
      readEventMetadata(db, {
        commandIdLike: "cmd:lookup-maintenance:%",
        tableId: "tbl_1"
      })
    ).toMatchObject({
      actor: {
        mode: "workflow",
        principalId: "wf_service"
      },
      coordinatorOwnedMutation: true,
      permissionScopeHash: "scope:wf:status-sync",
      permissionsVersion: 7,
      schemaEpoch: 0,
      scope: "table"
    });

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: "rec_account_2",
          valueType: "relation.record",
          version: 1
        }),
        "rec_account_2",
        "rec_account_2",
        JSON.stringify("rec_account_2"),
        "evt_seed_ticket_account_update",
        "ws_1",
        "tbl_1",
        "rec_ticket_1",
        "fld_account"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...lookupMessage,
          eventId: "evt_ticket_account_changed",
          payload: {
            ...lookupMessage.payload,
            trigger: {
              changedFieldIds: ["fld_account"],
              eventId: "evt_ticket_account_changed",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_ticket_1"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_account_name",
      recordId: "rec_ticket_1",
      tableId: "tbl_1"
    })).toBe("Globex");
  });

  it("executes aggregate backfill and rolling recompute through the coordinator-owned cell writer", async () => {
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
        dependsOnFieldIds: ["fld_account"],
        expression: "aggregate.account_open_ticket_count",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_2",
      recordKey: "account-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertWorkflowDefinition(db);
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "open_ticket_count",
          dependencyFieldIds: ["fld_account"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account",
            sourceFieldId: "fld_account"
          },
          operationConfig: {
            includeArchived: false
          },
          operationId: "count_records",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.account",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_open_ticket_count",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_status_sync",
        workflowVersionId: "wf_status_sync:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_open_ticket_count",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(1);
    expect(readCellRawValue(db, {
      fieldId: "fld_open_ticket_count",
      recordId: "rec_account_2",
      tableId: "tbl_accounts"
    })).toBe(0);
    expect(readRecordProjectionFields(db, {
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toEqual({
      open_ticket_count: 1
    });
    expect(eventFanoutQueue.sent).toHaveLength(2);

    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "rec_account_1"
    });

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_record_created_ticket_2",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_account"],
              eventId: "evt_record_created_ticket_2",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_open_ticket_count",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(2);
    expect(readCellRawValue(db, {
      fieldId: "fld_open_ticket_count",
      recordId: "rec_account_2",
      tableId: "tbl_accounts"
    })).toBe(0);
    expect(eventFanoutQueue.sent).toHaveLength(3);

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_record_created_ticket_2",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_account"],
              eventId: "evt_record_created_ticket_2",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    const aggregateEventCount = (
      db.inner
        .prepare(
          `SELECT COUNT(*) AS count
           FROM event_ledger
           WHERE workspace_id = ?
             AND table_id = ?
             AND command_id LIKE ?`
        )
        .get("ws_1", "tbl_accounts", "cmd:aggregate-maintenance:%") as { count: number }
    ).count;

    expect(aggregateEventCount).toBe(3);
    expect(eventFanoutQueue.sent).toHaveLength(3);
  });

  it("executes value-matched aggregate backfill and rolling recompute for grouped targets", async () => {
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
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      fieldId: "fld_ticket_count",
      fieldKey: "ticket_count",
      fieldType: "computed.readonly",
      label: "Ticket Count",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_region"],
        expression: "aggregate.region_ticket_count",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_apac_1",
      recordKey: "account-apac-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_apac_2",
      recordKey: "account-apac-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_emea",
      recordKey: "account-emea",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts",
      value: "emea"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertWorkflowDefinition(db, {
      workflowId: "wf_region_rollup",
      workflowKey: "region-rollup",
      workflowName: "Region Rollup"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "apac"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "ticket_count_by_region",
          dependencyFieldIds: ["fld_region"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "accounts_by_region",
            sourceFieldId: "fld_region"
          },
          operationConfig: {
            includeArchived: false
          },
          operationId: "count_records",
          resolver: {
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.accounts_by_region",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_ticket_count",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_region_rollup",
        workflowVersionId: "wf_region_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(1);
    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(1);
    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(0);

    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "apac"
    });

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_record_created_ticket_2",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_region"],
              eventId: "evt_record_created_ticket_2",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(2);
    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(2);
    expect(readCellRawValue(db, {
      fieldId: "fld_ticket_count",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(0);
  });

  it("delivers generic row.fields bindings through published workflow action delivery", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

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
    insertRecordProjection(db);
    insertCellCurrent(db, {
      fieldId: "fld_status",
      fieldType: "status.semantic",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "open"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"]
    });
    insertWorkflowDefinition(db, {
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
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_owner_delivery_1",
            idempotencyKey: "idem_trigger_owner_delivery_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; status: string }>();
    expect(workflowStep).toEqual({
      last_error_code: null,
      status: "completed"
    });

    const notificationCommand = await db
      .prepare(
        `SELECT payload_json
         FROM event_ledger
         WHERE command_id = ?`
      )
      .bind(`${workflowRun?.id}:action:0`)
      .first<{ payload_json: string }>();
    expect(JSON.parse(notificationCommand?.payload_json ?? "{}")).toMatchObject({
      channel: "activity",
      details: {
        recordStatus: "open",
        recordId: "rec_1"
      },
      message: "Status workflow step completed."
    });
  });

  it("delivers canonical row.owner bindings through published workflow action delivery", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

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
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertCellCurrent(db, {
      fieldId: "fld_owner",
      fieldType: "principal.user",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "usr_owner"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "emit_notification_event",
          input: {
            channel: "activity",
            details: {
              ownerId: {
                path: "row.owner.value"
              },
              recordId: {
                path: "row.recordId"
              }
            },
            message: "Owner workflow step completed."
          }
        }
      ],
      conditions: [
        {
          operatorId: "equals",
          input: {
            left: {
              path: "row.owner.value"
            },
            right: "usr_owner"
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
          createRouteBody({
            commandId: "cmd_trigger_row_owner_delivery_1",
            idempotencyKey: "idem_trigger_row_owner_delivery_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; status: string }>();
    expect(workflowStep).toEqual({
      last_error_code: null,
      status: "completed"
    });

    const notificationCommand = await db
      .prepare(
        `SELECT payload_json
         FROM event_ledger
         WHERE command_id = ?`
      )
      .bind(`${workflowRun?.id}:action:0`)
      .first<{ payload_json: string }>();
    expect(JSON.parse(notificationCommand?.payload_json ?? "{}")).toMatchObject({
      channel: "activity",
      details: {
        ownerId: "usr_owner",
        recordId: "rec_1"
      },
      message: "Owner workflow step completed."
    });
  });

  it("delivers field-declared canonical aliases through published workflow action delivery", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

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
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertCellCurrent(db, {
      fieldId: "fld_assignee",
      fieldType: "principal.user",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "usr_assignee"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "emit_notification_event",
          input: {
            channel: "activity",
            details: {
              assigneeId: {
                path: "row.assignee.value"
              },
              recordId: {
                path: "row.recordId"
              }
            },
            message: "Assignee workflow step completed."
          }
        }
      ],
      conditions: [
        {
          operatorId: "equals",
          input: {
            left: {
              path: "row.assignee.value"
            },
            right: "usr_assignee"
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
          createRouteBody({
            commandId: "cmd_trigger_assignee_delivery_1",
            idempotencyKey: "idem_trigger_assignee_delivery_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; status: string }>();
    expect(workflowStep).toEqual({
      last_error_code: null,
      status: "completed"
    });

    const notificationCommand = await db
      .prepare(
        `SELECT payload_json
         FROM event_ledger
         WHERE command_id = ?`
      )
      .bind(`${workflowRun?.id}:action:0`)
      .first<{ payload_json: string }>();
    expect(JSON.parse(notificationCommand?.payload_json ?? "{}")).toMatchObject({
      channel: "activity",
      details: {
        assigneeId: "usr_assignee",
        recordId: "rec_1"
      },
      message: "Assignee workflow step completed."
    });
  });

  it("keeps canonical row.owner condition misses on the generic conditions-failed runtime path", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

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
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertCellCurrent(db, {
      fieldId: "fld_owner",
      fieldType: "principal.user",
      recordId: "rec_1",
      tableId: "tbl_1",
      value: "usr_other"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"]
    });
    insertWorkflowDefinition(db, {
      actions: [
        {
          operatorId: "emit_notification_event",
          input: {
            channel: "activity",
            details: {
              ownerId: {
                path: "row.owner.value"
              },
              recordId: {
                path: "row.recordId"
              }
            },
            message: "Owner workflow step completed."
          }
        }
      ],
      conditions: [
        {
          operatorId: "equals",
          input: {
            left: {
              path: "row.owner.value"
            },
            right: "usr_owner"
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
          createRouteBody({
            commandId: "cmd_trigger_row_owner_delivery_negative_1",
            idempotencyKey: "idem_trigger_row_owner_delivery_negative_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("failed");

    const workflowStep = await db
      .prepare(
        `SELECT status, last_error_code, output_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{ last_error_code: string | null; output_json: string; status: string }>();
    expect(workflowStep?.status).toBe("failed");
    expect(workflowStep?.last_error_code).toBe("workflow_action_failed");
    expect(JSON.parse(workflowStep?.output_json ?? "{}")).toMatchObject({
      conditionResults: [
        {
          operatorId: "equals",
          passed: false,
          resolvedInput: {
            left: "usr_other",
            right: "usr_owner"
          }
        }
      ],
      executedActions: [],
      matchedTrigger: true,
      skippedReason: "conditions_failed",
      workflowId: "wf_status_sync"
    });

    const notificationEvents = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM event_ledger
         WHERE event_type = ?`
      )
      .bind("notification.emitted")
      .first<{ count: number }>();
    expect(notificationEvents?.count).toBe(0);
    expect(eventFanoutQueue.sent).toHaveLength(1);
  });

  it("schedules retryable webhook failures with bounded backoff and keeps duplicate delivery idempotent", async () => {
    const {
      db,
      env,
      eventFanoutQueue,
      workflowDispatchQueue,
      workflowStepQueue
    } = createEnv();
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
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.webhook.enqueue"]
    });
    insertWorkflowDefinition(db, {
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
          createRouteBody({
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowStepQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    const retryingWorkflowRun = await db
      .prepare(`SELECT id, status, state_json FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; state_json: string; status: string }>();
    expect(retryingWorkflowRun?.status).toBe("waiting_retry");

    const workflowStep = await db
      .prepare(
        `SELECT id, status, last_error_code, audit_json
         FROM workflow_run_steps
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind()
      .first<{
        audit_json: string;
        id: string;
        last_error_code: string | null;
        status: string;
      }>();
    expect(workflowStep).toMatchObject({
      last_error_code: "workflow_webhook_http_503",
      status: "retryable_failed"
    });
    expect(workflowStepQueue.sends).toHaveLength(2);
    expect(workflowStepQueue.sends[1]?.options?.delaySeconds).toBe(30);

    const retryMessage = workflowStepQueue.sent[1]!;
    expect(retryMessage.retry).toMatchObject({
      attempt: 2,
      delaySeconds: 30,
      maxAttempts: 8,
      retryClass: "network"
    });
    const runState = JSON.parse(retryingWorkflowRun?.state_json ?? "{}") as {
      retry?: { nextAttemptAt?: string };
    };
    const stepAudit = JSON.parse(workflowStep?.audit_json ?? "{}") as {
      retry?: { nextAttemptAt?: string };
    };
    expect(runState.retry?.nextAttemptAt).toBe(retryMessage.retry?.nextAttemptAt);
    expect(stepAudit.retry?.nextAttemptAt).toBe(retryMessage.retry?.nextAttemptAt);

    vi.setSystemTime(new Date(retryMessage.retry!.nextAttemptAt));
    await handleQueueBatch(createBatch([retryMessage]).batch as never, env, {} as ExecutionContext);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const workflowRun = await db
      .prepare(`SELECT id, status FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ id: string; status: string }>();
    expect(workflowRun?.status).toBe("completed");

    const webhookEvents = await db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM event_ledger
         WHERE event_type = ?`
      )
      .bind("workflow.webhook.enqueued")
      .first<{ count: number }>();
    expect(webhookEvents?.count).toBe(1);

    await handleQueueBatch(createBatch([retryMessage]).batch as never, env, {} as ExecutionContext);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("dead-letters webhook retries after the bounded budget is exhausted", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00.000Z"));
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("upstream unavailable", {
            status: 503
          })
      );

    insertField(db, {
      fieldId: "fld_source",
      fieldKey: "source",
      fieldType: "text.single_line",
      label: "Source",
      tableId: "tbl_1"
    });
    insertRecordProjection(db);
    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.webhook.enqueue"]
    });
    insertWorkflowDefinition(db, {
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
          createRouteBody({
            commandId: "cmd_trigger_webhook_retry_budget_1",
            idempotencyKey: "idem_trigger_webhook_retry_budget_1",
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

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(createBatch([workflowDispatchQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    let pendingMessage = workflowStepQueue.sent[0]!;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      if (pendingMessage.retry) {
        vi.setSystemTime(new Date(pendingMessage.retry.nextAttemptAt));
      }
      await handleQueueBatch(createBatch([pendingMessage]).batch as never, env, {} as ExecutionContext);
      pendingMessage = workflowStepQueue.sent.at(-1)!;
    }

    const workflowRun = await db
      .prepare(`SELECT status, dead_lettered_at FROM workflow_runs ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ dead_lettered_at: string | null; status: string }>();
    expect(workflowRun).toMatchObject({
      dead_lettered_at: expect.any(String),
      status: "dead_lettered"
    });

    const workflowStep = await db
      .prepare(`SELECT status, last_error_code FROM workflow_run_steps ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ last_error_code: string | null; status: string }>();
    expect(workflowStep).toMatchObject({
      last_error_code: "workflow_webhook_http_503",
      status: "dead_lettered"
    });

    const deadLetter = await db
      .prepare(`SELECT queue_name, attempt_count FROM workflow_dead_letters ORDER BY id ASC LIMIT 1`)
      .bind()
      .first<{ attempt_count: number; queue_name: string }>();
    expect(deadLetter).toMatchObject({
      attempt_count: 8,
      queue_name: "workflow-step"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(8);
    vi.useRealTimers();
  });

  it("routes numeric aggregate recompute envelopes with operand metadata", async () => {
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
      fieldId: "fld_revenue_sum",
      fieldKey: "revenue_sum",
      fieldType: "computed.readonly",
      label: "Revenue Sum",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_amount"],
        expression: "aggregate.account_revenue_sum",
        resultValueType: "number"
      }
    });
    insertRecordProjection(db);
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "revenue_sum",
            groupingSource: {
              kind: "related_record",
              resolverAlias: "account"
            },
            operand: {
              fieldId: "fld_amount",
              kind: "source_field",
              valueType: "number"
            },
            operationId: "sum_numbers",
            sourceRelationPath: "relatedTables.account",
            targetFieldId: "fld_revenue_sum"
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
      workflowId: "wf_revenue_rollup",
      workflowVersionId: "wf_revenue_rollup:v1"
    });

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_1/cells/fld_amount", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_trigger_numeric_aggregate_recompute",
            idempotencyKey: "idem_trigger_numeric_aggregate_recompute",
            payload: {
              fieldType: "number.decimal",
              value: 12.5
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(response.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);

    expect(aggregateQueue.sent).toHaveLength(1);
    expect(aggregateQueue.sent[0]).toMatchObject({
      kind: "aggregate-maintenance",
      workspaceId: "ws_1",
      payload: {
        aggregate: {
          alias: "revenue_sum",
          dependencyFieldIds: ["fld_account", "fld_amount"],
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "sum_numbers",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          targetFieldId: "fld_revenue_sum"
        },
        trigger: {
          changedFieldIds: ["fld_amount"],
          kind: "recompute"
        }
      }
    });
  });

  it("executes numeric aggregate backfill and recompute for single-relation groups", async () => {
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
      fieldId: "fld_revenue_sum",
      fieldKey: "revenue_sum",
      fieldType: "computed.readonly",
      label: "Revenue Sum",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_amount"],
        expression: "aggregate.account_revenue_sum",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_2",
      recordKey: "account-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 10
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: null
    });
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "revenue_sum",
            dependencyFieldIds: ["fld_account", "fld_amount"],
            groupingSource: {
              kind: "related_record",
              resolverAlias: "account"
            },
            operand: {
              fieldId: "fld_amount",
              kind: "source_field",
              valueType: "number"
            },
            operationId: "sum_numbers",
            sourceRelationPath: "relatedTables.account",
            targetFieldId: "fld_revenue_sum"
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
      workflowId: "wf_revenue_rollup",
      workflowVersionId: "wf_revenue_rollup:v1"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "revenue_sum",
          dependencyFieldIds: ["fld_account", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account",
            sourceFieldId: "fld_account"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "sum_numbers",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.account",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_revenue_sum",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_revenue_rollup",
        workflowVersionId: "wf_revenue_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_revenue_sum",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(10);
    expect(readCellRawValue(db, {
      fieldId: "fld_revenue_sum",
      recordId: "rec_account_2",
      tableId: "tbl_accounts"
    })).toBe(0);
    expect(
      readEventMetadata(db, {
        commandIdLike: "cmd:aggregate-maintenance:%",
        tableId: "tbl_accounts"
      })
    ).toMatchObject({
      actor: {
        mode: "workflow",
        principalId: "wf_service"
      },
      coordinatorOwnedMutation: true,
      permissionScopeHash: "scope:wf:status-sync",
      permissionsVersion: 7,
      schemaEpoch: 0,
      scope: "table"
    });

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, number_value = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: 5.5,
          valueType: "number.decimal",
          version: 1
        }),
        5.5,
        "5.5",
        "5.5",
        JSON.stringify(5.5),
        "evt_seed_rec_ticket_2_fld_amount_update",
        "ws_1",
        "tbl_1",
        "rec_ticket_2",
        "fld_amount"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_amount_changed",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_amount"],
              eventId: "evt_ticket_2_amount_changed",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_revenue_sum",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(15.5);
    expect(
      readEventMetadata(db, {
        commandIdLike: "cmd:aggregate-maintenance:%",
        tableId: "tbl_accounts"
      })
    ).toMatchObject({
      actor: {
        mode: "workflow",
        principalId: "wf_service"
      },
      coordinatorOwnedMutation: true,
      permissionScopeHash: "scope:wf:status-sync",
      permissionsVersion: 7,
      schemaEpoch: 0,
      scope: "table"
    });
  });

  it("executes max_number aggregate backfill and recompute for single-relation groups", async () => {
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
      fieldId: "fld_max_amount",
      fieldKey: "max_amount",
      fieldType: "computed.readonly",
      label: "Max Amount",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_amount"],
        expression: "aggregate.account_max_amount",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_2",
      recordKey: "account-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 10
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: 4
    });
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "max_amount",
            dependencyFieldIds: ["fld_account", "fld_amount"],
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
            targetFieldId: "fld_max_amount"
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
      workflowId: "wf_max_amount_rollup",
      workflowVersionId: "wf_max_amount_rollup:v1"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "max_amount",
          dependencyFieldIds: ["fld_account", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account",
            sourceFieldId: "fld_account"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "max_number",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.account",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_max_amount",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_max_amount_rollup",
        workflowVersionId: "wf_max_amount_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_max_amount",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(10);
    expect(readCellRawValue(db, {
      fieldId: "fld_max_amount",
      recordId: "rec_account_2",
      tableId: "tbl_accounts"
    })).toBe(null);

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, number_value = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: 25,
          valueType: "number.decimal",
          version: 1
        }),
        25,
        "25",
        "25",
        JSON.stringify(25),
        "evt_seed_rec_ticket_2_fld_amount_max_update",
        "ws_1",
        "tbl_1",
        "rec_ticket_2",
        "fld_amount"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_max_amount_changed",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_amount"],
              eventId: "evt_ticket_2_max_amount_changed",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_max_amount",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(25);
  });

  it("executes average_numbers aggregate backfill and recompute for single-relation groups", async () => {
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
      fieldId: "fld_avg_amount",
      fieldKey: "avg_amount",
      fieldType: "computed.readonly",
      label: "Average Amount",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_account", "fld_amount"],
        expression: "aggregate.account_avg_amount",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_2",
      recordKey: "account-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 10
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: 4
    });
    insertWorkflowDefinition(db, {
      metadata: {
        aggregateDefinitions: [
          {
            alias: "avg_amount",
            dependencyFieldIds: ["fld_account", "fld_amount"],
            groupingSource: {
              kind: "related_record",
              resolverAlias: "account"
            },
            operand: {
              fieldId: "fld_amount",
              kind: "source_field",
              valueType: "number"
            },
            operationId: "average_numbers",
            sourceRelationPath: "relatedTables.account",
            targetFieldId: "fld_avg_amount"
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
      workflowId: "wf_avg_amount_rollup",
      workflowVersionId: "wf_avg_amount_rollup:v1"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "avg_amount",
          dependencyFieldIds: ["fld_account", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account",
            sourceFieldId: "fld_account"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "average_numbers",
          resolver: {
            sourceFieldId: "fld_account",
            strategy: "single_relation",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.account",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_avg_amount",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_avg_amount_rollup",
        workflowVersionId: "wf_avg_amount_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_avg_amount",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_avg_amount",
      recordId: "rec_account_2",
      tableId: "tbl_accounts"
    })).toBe(null);

    db.inner
      .prepare(
        `UPDATE cell_current
         SET value_json = ?, number_value = ?, display_value = ?, search_text = ?, value_hash = ?, last_event_id = ?
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .run(
        JSON.stringify({
          isEmpty: false,
          raw: 26,
          valueType: "number.decimal",
          version: 1
        }),
        26,
        "26",
        "26",
        JSON.stringify(26),
        "evt_seed_rec_ticket_2_fld_amount_avg_update",
        "ws_1",
        "tbl_1",
        "rec_ticket_2",
        "fld_amount"
      );

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_avg_amount_changed",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_amount"],
              eventId: "evt_ticket_2_avg_amount_changed",
              eventType: "cell.updated",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_avg_amount",
      recordId: "rec_account_1",
      tableId: "tbl_accounts"
    })).toBe(18);
  });

  it("executes numeric aggregate backfill and recompute for value-matched groups", async () => {
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
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      fieldId: "fld_region_revenue",
      fieldKey: "region_revenue",
      fieldType: "computed.readonly",
      label: "Region Revenue",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_region", "fld_amount"],
        expression: "aggregate.region_revenue_sum",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_apac_1",
      recordKey: "account-apac-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_apac_2",
      recordKey: "account-apac-2",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_account_emea",
      recordKey: "account-emea",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts",
      value: "emea"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 7
    });
    insertWorkflowDefinition(db, {
      workflowId: "wf_region_revenue_rollup",
      workflowKey: "region-revenue-rollup",
      workflowName: "Region Revenue Rollup"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "region_revenue",
          dependencyFieldIds: ["fld_region", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "accounts_by_region",
            sourceFieldId: "fld_region"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "sum_numbers",
          resolver: {
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.accounts_by_region",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_region_revenue",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_region_revenue_rollup",
        workflowVersionId: "wf_region_revenue_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_region_revenue",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_revenue",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_revenue",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(0);

    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "emea"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: 3
    });

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_created",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_region", "fld_amount"],
              eventId: "evt_ticket_2_created",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_region_revenue",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_revenue",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(3);
  });

  it("executes average_numbers aggregate backfill and recompute for value-matched groups", async () => {
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
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      fieldId: "fld_region_average",
      fieldKey: "region_average",
      fieldType: "computed.readonly",
      label: "Region Average",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_region", "fld_amount"],
        expression: "aggregate.region_average",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_apac_1",
      recordKey: "account-apac-1",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertRecord(db, {
      recordId: "rec_account_apac_2",
      recordKey: "account-apac-2",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertRecord(db, {
      recordId: "rec_account_emea",
      recordKey: "account-emea",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts",
      value: "emea"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 7
    });
    insertWorkflowDefinition(db, {
      workflowId: "wf_region_average_rollup",
      workflowKey: "region-average-rollup",
      workflowName: "Region Average Rollup"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "region_average",
          dependencyFieldIds: ["fld_region", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "accounts_by_region",
            sourceFieldId: "fld_region"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "average_numbers",
          resolver: {
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.accounts_by_region",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_region_average",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_region_average_rollup",
        workflowVersionId: "wf_region_average_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(null);

    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: 5
    });

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_region_average_created",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_region", "fld_amount"],
              eventId: "evt_ticket_2_region_average_created",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(6);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(6);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_average",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(null);
  });

  it("executes max_number aggregate backfill and recompute for value-matched groups", async () => {
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
      fieldId: "fld_region",
      fieldKey: "region",
      fieldType: "text.single_line",
      label: "Region",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_amount",
      fieldKey: "amount",
      fieldType: "number.decimal",
      label: "Amount",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_region_key",
      fieldKey: "region_key",
      fieldType: "text.single_line",
      label: "Region Key",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      fieldId: "fld_region_max",
      fieldKey: "region_max",
      fieldType: "computed.readonly",
      label: "Region Max",
      tableId: "tbl_accounts",
      config: {
        dependsOnFieldIds: ["fld_region", "fld_amount"],
        expression: "aggregate.region_max",
        resultValueType: "number"
      }
    });
    insertRecord(db, {
      recordId: "rec_account_apac_1",
      recordKey: "account-apac-1",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertRecord(db, {
      recordId: "rec_account_apac_2",
      recordKey: "account-apac-2",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts",
      value: "apac"
    });
    insertRecord(db, {
      recordId: "rec_account_emea",
      recordKey: "account-emea",
      tableId: "tbl_accounts"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region_key",
      fieldType: "text.single_line",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts",
      value: "emea"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 7
    });
    insertWorkflowDefinition(db, {
      workflowId: "wf_region_max_rollup",
      workflowKey: "region-max-rollup",
      workflowName: "Region Max Rollup"
    });

    const aggregateMessage: CloudTableQueueMessage = {
      kind: "aggregate-maintenance",
      payload: {
        aggregate: {
          alias: "region_max",
          dependencyFieldIds: ["fld_region", "fld_amount"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "accounts_by_region",
            sourceFieldId: "fld_region"
          },
          operand: {
            fieldId: "fld_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "max_number",
          resolver: {
            sourceFieldId: "fld_region",
            strategy: "value_match",
            targetFieldId: "fld_region_key",
            targetTableId: "tbl_accounts"
          },
          sourceRelationPath: "relatedTables.accounts_by_region",
          sourceTableId: "tbl_1",
          targetFieldId: "fld_region_max",
          targetTableId: "tbl_accounts"
        },
        trigger: {
          kind: "backfill",
          reason: "workflow_published"
        },
        workflowId: "wf_region_max_rollup",
        workflowVersionId: "wf_region_max_rollup:v1"
      },
      workspaceId: "ws_1"
    };

    await handleQueueBatch(createBatch([aggregateMessage]).batch as never, env, {} as ExecutionContext);

    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(7);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(null);

    insertRecord(db, {
      recordId: "rec_ticket_2",
      recordKey: "ticket-2"
    });
    insertCellCurrent(db, {
      fieldId: "fld_region",
      fieldType: "text.single_line",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: "apac"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_2",
      tableId: "tbl_1",
      value: 12
    });

    await handleQueueBatch(
      createBatch([
        {
          ...aggregateMessage,
          eventId: "evt_ticket_2_region_max_created",
          payload: {
            ...aggregateMessage.payload,
            trigger: {
              changedFieldIds: ["fld_region", "fld_amount"],
              eventId: "evt_ticket_2_region_max_created",
              eventType: "record.created",
              kind: "recompute",
              recordId: "rec_ticket_2"
            }
          }
        }
      ]).batch as never,
      env,
      {} as ExecutionContext
    );

    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_apac_1",
      tableId: "tbl_accounts"
    })).toBe(12);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_apac_2",
      tableId: "tbl_accounts"
    })).toBe(12);
    expect(readCellRawValue(db, {
      fieldId: "fld_region_max",
      recordId: "rec_account_emea",
      tableId: "tbl_accounts"
    })).toBe(null);
  });

  it("retries aggregate maintenance and preserves product state when workflow service identity metadata is malformed", async () => {
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
      fieldId: "fld_account",
      fieldKey: "account",
      fieldType: "relation.record",
      label: "Account",
      tableId: "tbl_1"
    });
    insertField(db, {
      fieldId: "fld_amount",
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
    insertRecord(db, {
      recordId: "rec_account_1",
      recordKey: "account-1",
      tableId: "tbl_accounts"
    });
    insertRecord(db, {
      recordId: "rec_ticket_1",
      recordKey: "ticket-1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_account",
      fieldType: "relation.record",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: "rec_account_1"
    });
    insertCellCurrent(db, {
      fieldId: "fld_amount",
      fieldType: "number.decimal",
      recordId: "rec_ticket_1",
      tableId: "tbl_1",
      value: 10
    });
    insertWorkflowDefinition(db, {
      definitionJson: "{not-json",
      workflowId: "wf_revenue_rollup_fallback",
      workflowVersionId: "wf_revenue_rollup_fallback:v1"
    });

    const batch = createBatchWithRetryTracking([
      {
        kind: "aggregate-maintenance",
        payload: {
          aggregate: {
            alias: "revenue_sum",
            dependencyFieldIds: ["fld_account", "fld_amount"],
            groupingSource: {
              kind: "related_record",
              resolverAlias: "account",
              sourceFieldId: "fld_account"
            },
            operand: {
              fieldId: "fld_amount",
              kind: "source_field",
              valueType: "number"
            },
            operationId: "sum_numbers",
            resolver: {
              sourceFieldId: "fld_account",
              strategy: "single_relation",
              targetTableId: "tbl_accounts"
            },
            sourceRelationPath: "relatedTables.account",
            sourceTableId: "tbl_1",
            targetFieldId: "fld_revenue_sum",
            targetTableId: "tbl_accounts"
          },
          trigger: {
            kind: "backfill",
            reason: "workflow_published"
          },
          workflowId: "wf_revenue_rollup_fallback",
          workflowVersionId: "wf_revenue_rollup_fallback:v1"
        },
        workspaceId: "ws_1"
      }
    ]);

    await handleQueueBatch(batch.batch as never, env, {} as ExecutionContext);

    expect(batch.retried).toBe(1);
    const maintenanceEvents = db.inner
      .prepare(
        `SELECT COUNT(*) AS count
         FROM event_ledger
         WHERE workspace_id = ? AND table_id = ? AND command_id LIKE ?`
      )
      .get("ws_1", "tbl_accounts", "cmd:aggregate-maintenance:%") as { count: number };
    expect(maintenanceEvents.count).toBe(0);
    expect(
      readCellRawValue(db, {
        fieldId: "fld_revenue_sum",
        recordId: "rec_account_1",
        tableId: "tbl_accounts"
      })
    ).toBe(null);
  });
});
