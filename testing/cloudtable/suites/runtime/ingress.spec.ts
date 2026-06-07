import { describe, expect, it } from "vitest";

import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import { handleQueueBatch } from "../../../../src/queues/consumer";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { handleFetch } from "../../../../src/runtime/worker";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
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

  async send(message: CloudTableQueueMessage): Promise<void> {
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
    ARTIFACTS_BUCKET: {} as R2Bucket,
    DB: db as unknown as D1Database,
    DEAD_LETTER_REPROCESSOR_QUEUE: deadLetterQueue as unknown as Queue<CloudTableQueueMessage>,
    EVENT_FANOUT_QUEUE: eventFanoutQueue as unknown as Queue<CloudTableQueueMessage>,
    PROJECTION_MAINTENANCE_QUEUE: projectionQueue as unknown as Queue<CloudTableQueueMessage>,
    TABLE_COORDINATOR_DO: tableNamespace as unknown as DurableObjectNamespace,
    WORKFLOW_DISPATCH_QUEUE: workflowQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKFLOW_STEP_QUEUE: workflowStepQueue as unknown as Queue<CloudTableQueueMessage>,
    WORKSPACE_CONTROL_DO: workspaceNamespace as unknown as DurableObjectNamespace
  };

  return {
    db,
    deadLetterQueue,
    env,
    eventFanoutQueue,
    projectionQueue,
    workflowDispatchQueue: workflowQueue,
    workflowStepQueue
  };
}

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
        field_key,
        label,
        field_type,
        field_type_version,
        config_json,
        created_at,
        updated_at,
        archived_at,
        last_event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.fieldId,
      input.workspaceId ?? "ws_1",
      input.tableId,
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

function insertFieldIndexEntry(
  db: SqliteD1Database,
  input: {
    boolValue?: boolean | null;
    datetimeValue?: string | null;
    fieldId: string;
    numberValue?: number | null;
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
      input.textValue ?? null,
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
      workflowId: string;
    };
    expect(runBody).toMatchObject({
      id: "wfr_history_1",
      status: "dead_lettered",
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

  it("returns persisted workflow definition metadata through the worker read ingress", async () => {
    const { db, env } = createEnv();
    insertWorkflow(db, {
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            eventTypes: ["record.updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record.updated"
        },
        conditions: [
          {
            input: {
              equals: "ready",
              fieldId: "fld_status"
            },
            operatorId: "value.equals"
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
    expect((await response.json()) as Record<string, unknown>).toEqual({
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
              equals: "ready",
              fieldId: "fld_status"
            },
            operatorId: "value.equals"
          }
        ],
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            eventTypes: ["record.updated"],
            fieldId: "fld_status",
            tableId: "tbl_1"
          },
          operatorId: "record.updated"
        },
        workflowId: "wf_definition_detail"
      },
      publishedAt: "2026-06-06T00:00:00.000Z",
      status: "paused",
      triggerTableId: "tbl_1",
      workflowId: "wf_definition_detail",
      workflowKey: "workflow-detail",
      workflowName: "Workflow Detail",
      workflowVersionId: "wf_definition_detail:v1",
      workspaceId: "ws_1"
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
            tableIds: string[];
          }>;
          catalog: {
            fieldTypes: string[];
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
    expect(body.output.workspace.catalog.fieldTypes).toContain("text.single_line");
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
        fieldTypes: string[];
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
    expect(body.catalog.fieldTypes).toContain("text.single_line");
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
        fieldTypes: string[];
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
    expect(body.catalog?.fieldTypes).toContain("text.single_line");
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
      view: { allowed: boolean };
    };

    expect(body.view.allowed).toBe(true);
    expect(body.rows).toEqual([]);
    expect(body.groups).toEqual([
      {
        bucketKey: "\"active\"",
        groupLabel: "active",
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
