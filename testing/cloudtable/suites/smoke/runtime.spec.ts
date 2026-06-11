import { describe, expect, it } from "vitest";

import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { serializeWorkflowOperatorManifest } from "../../../../src/core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { handleQueueBatch } from "../../../../src/queues/consumer";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
import { handleFetch, handleScheduled } from "../../../../src/runtime/worker";
import {
  SqliteD1Database,
  seedAppAndTable,
  seedWorkspace
} from "../../harness/runtime/sqlite-d1";

type StoredValue = unknown;

const workflowOperatorRegistry = createWorkflowOperatorRegistry();

function supportedConditionOperatorManifests(operatorIds: readonly string[]) {
  return operatorIds.map((operatorId) =>
    serializeWorkflowOperatorManifest(workflowOperatorRegistry.require(operatorId))
  );
}

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

function createEnv(): {
  db: SqliteD1Database;
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

function createScheduledController(scheduledTime: number): ScheduledController {
  return {
    cron: "* * * * *",
    noRetry() {},
    scheduledTime
  } as ScheduledController;
}

function insertPermissionSnapshot(
  db: SqliteD1Database,
  input: {
    commandTypes: string[];
    fields: Record<string, unknown>;
    policyRevision?: number;
    principalId: string;
    scopeHash: string;
    snapshotId?: string;
  }
): void {
  const policyRevision = input.policyRevision ?? 7;
  const snapshotId = input.snapshotId ?? `snap_${input.principalId}_${policyRevision}`;

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
      input.principalId,
      policyRevision,
      input.scopeHash,
      JSON.stringify({
        snapshotId,
        workspaceId: "ws_1",
        principalId: input.principalId,
        policyRevision,
        schemaEpoch: 0,
        scopeHash: input.scopeHash,
        commandTypes: input.commandTypes,
        fields: input.fields
      }),
      "2026-06-06T00:00:00.000Z"
    );
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
      null,
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
      "ws_1",
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

function insertFieldIndexEntry(
  db: SqliteD1Database,
  input: {
    fieldId: string;
    recordId: string;
    referenceValue?: string | null;
    tableId: string;
    textValue?: string | null;
  }
): void {
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
      input.tableId,
      input.fieldId,
      input.recordId,
      input.textValue ?? input.referenceValue ?? null,
      null,
      null,
      null,
      `evt_index_${input.recordId}_${input.fieldId}`
    );
}

function insertView(
  db: SqliteD1Database,
  input: {
    filters: Array<{
      fieldId: string;
      operatorId: string;
      value?: unknown;
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
        filterFieldIds: input.filters.map((filter) => filter.fieldId),
        filters: input.filters,
        groupByFieldId: null,
        showEmptyGroups: false,
        sortFieldIds: [],
        sorts: [],
        visibleFieldIds: input.visibleFieldIds
      }),
      "2026-06-06T00:00:00.000Z",
      "usr_owner",
      null
    );
}

describe("cloudtable runtime smoke", () => {
  it("executes the worker command vertical slice against seeded Cloudflare runtime bindings", async () => {
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

  it("proves the canonical row.owner workflow contract through the smoke runtime path", async () => {
    const { db, env, eventFanoutQueue, workflowDispatchQueue, workflowStepQueue } = createEnv();

    const ownerFieldAccess = {
      agent: true,
      fieldId: "fld_owner",
      fieldType: "principal.user",
      read: "visible",
      workflow: true,
      write: true
    };
    const sourceFieldAccess = {
      agent: true,
      fieldId: "fld_source",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    };

    insertPermissionSnapshot(db, {
      commandTypes: ["workflow.create", "workflow.publish"],
      fields: {
        fld_owner: ownerFieldAccess,
        fld_source: sourceFieldAccess
      },
      policyRevision: 44,
      principalId: "usr_owner",
      scopeHash: "scope:table:tbl_1"
    });
    insertPermissionSnapshot(db, {
      commandTypes: ["notification.emit"],
      fields: {
        fld_owner: ownerFieldAccess,
        fld_source: sourceFieldAccess
      },
      principalId: "wf_service",
      scopeHash: "scope:wf:owner-smoke"
    });

    const createOwnerField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_owner_smoke",
            idempotencyKey: "idem_field_owner_smoke",
            payload: {
              config: {
                rowOwner: true
              },
              fieldId: "fld_owner",
              fieldKey: "owner",
              fieldType: "principal.user",
              label: "Owner"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createOwnerField.status).toBe(200);

    const createSourceField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_source_smoke",
            idempotencyKey: "idem_field_source_smoke",
            payload: {
              fieldId: "fld_source",
              fieldKey: "source",
              fieldType: "text.single_line",
              label: "Source"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createSourceField.status).toBe(200);

    const schemaResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/schema?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:table:tbl_1&policyRevision=44"
      ),
      env,
      {} as ExecutionContext
    );
    expect(schemaResponse.status).toBe(200);
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
      };
      workflow: {
        bindings: Record<string, { fieldId: string; template: { valuePath: string } }>;
      };
    };
    expect(schemaBody.workflow.bindings["row.owner"]).toMatchObject({
      fieldId: "fld_owner",
      template: {
        valuePath: "row.owner.value"
      }
    });
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

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_owner_smoke",
            idempotencyKey: "idem_record_owner_smoke",
            payload: {
              recordId: "rec_owner_smoke"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const createWorkflow = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/workflows", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_owner_smoke",
            idempotencyKey: "idem_workflow_owner_smoke",
            payload: {
              definition: {
                actions: [
                  {
                    input: {
                      channel: "activity",
                      details: {
                        owner: {
                          path: "row.owner.value"
                        },
                        recordId: {
                          path: "row.recordId"
                        }
                      },
                      message: "Owner workflow step completed."
                    },
                    operatorId: "emit_notification_event"
                  }
                ],
                conditions: [
                  {
                    input: {
                      left: {
                        path: "row.owner.value"
                      },
                      right: ["usr_owner"]
                    },
                    operatorId: "equals"
                  }
                ],
                principal: {
                  policyRevision: 7,
                  principalId: "wf_service",
                  schemaEpoch: 0,
                  scopeHash: "scope:wf:owner-smoke"
                },
                trigger: {
                  match: {
                    fieldId: "fld_source",
                    fromWorkflow: false,
                    tableId: "tbl_1"
                  },
                  operatorId: "field_changed"
                },
                workflowId: "wf_owner_smoke"
              },
              name: "Owner Smoke",
              workflowId: "wf_owner_smoke",
              workflowKey: "owner-smoke"
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
      new Request("https://example.test/v1/workflows/wf_owner_smoke/publish", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_workflow_owner_smoke_publish",
            idempotencyKey: "idem_workflow_owner_smoke_publish"
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

    eventFanoutQueue.sent.length = 0;

    const setSource = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records/rec_owner_smoke/cells/fld_source", {
        method: "PATCH",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_owner_smoke_trigger",
            idempotencyKey: "idem_owner_smoke_trigger",
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
    expect(setSource.status).toBe(200);

    await handleQueueBatch(createBatch([eventFanoutQueue.sent[0]!]).batch as never, env, {} as ExecutionContext);
    await handleQueueBatch(
      createBatch([workflowDispatchQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    await handleQueueBatch(
      createBatch([workflowStepQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const workflowRun = await db
      .prepare(
        `SELECT id
         FROM workflow_runs
         WHERE workflow_id = ?
         ORDER BY id ASC
         LIMIT 1`
      )
      .bind("wf_owner_smoke")
      .first<{ id: string }>();
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
        owner: ["usr_owner"],
        recordId: "rec_owner_smoke"
      },
      message: "Owner workflow step completed."
    });
  });

  it("proves the canonical row.owner agent-tool preview through the smoke runtime path", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      commandTypes: ["field.create", "workflow.create"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
          fieldType: "principal.user",
          read: "visible",
          workflow: true,
          write: true
        }
      },
      policyRevision: 45,
      principalId: "usr_owner",
      scopeHash: "scope:table:tbl_1"
    });

    const createOwnerField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_owner_preview_smoke",
            idempotencyKey: "idem_field_owner_preview_smoke",
            payload: {
              config: {
                rowOwner: true
              },
              fieldId: "fld_owner",
              fieldKey: "owner",
              fieldType: "principal.user",
              label: "Owner"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createOwnerField.status).toBe(200);

    const previewResponse = await handleFetch(
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
            workflowId: "wf_owner_assigned_smoke"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 45,
          principalId: "usr_owner",
          toolId: "proposeWorkflow",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(previewResponse.status).toBe(200);
    expect(
      (await previewResponse.json()) as {
        output: {
          command: {
            payload: {
              definition: {
                conditions: unknown[];
              };
            };
          };
          kind: string;
          proposal: {
            conditions: unknown[];
          };
        };
      }
    ).toMatchObject({
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
        },
        command: {
          payload: {
            definition: {
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
        }
      }
    });
  });

  it("proves owner-filtered saved-view query parity through the smoke runtime path", async () => {
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
      recordId: "rec_owner_smoke_1",
      recordKey: "owner-smoke-1",
      tableId: "tbl_1"
    });
    insertRecordProjection(db, {
      fields: {
        owner: ["usr_other"],
        title: "Owned by other"
      },
      recordId: "rec_owner_smoke_2",
      recordKey: "owner-smoke-2",
      tableId: "tbl_1"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_owner",
      recordId: "rec_owner_smoke_1",
      referenceValue: "usr_owner",
      tableId: "tbl_1",
      textValue: "usr_owner"
    });
    insertFieldIndexEntry(db, {
      fieldId: "fld_owner",
      recordId: "rec_owner_smoke_2",
      referenceValue: "usr_other",
      tableId: "tbl_1",
      textValue: "usr_other"
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
      viewId: "view_owner_smoke",
      viewKey: "owner-smoke",
      viewName: "Owner Smoke",
      visibleFieldIds: ["fld_title", "fld_owner"]
    });
    insertPermissionSnapshot(db, {
      commandTypes: [],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
          fieldType: "principal.user",
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
      policyRevision: 47,
      principalId: "usr_owner",
      scopeHash: "scope:view:view_owner_smoke",
      snapshotId: "snap_view_owner_smoke"
    });

    const directResponse = await handleFetch(
      new Request(
        "https://example.test/v1/tables/tbl_1/views/view_owner_smoke?workspaceId=ws_1&principalId=usr_owner&permissionScopeHash=scope:view:view_owner_smoke&policyRevision=47"
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
            viewId: "view_owner_smoke"
          },
          permissionScopeHash: "scope:view:view_owner_smoke",
          policyRevision: 47,
          principalId: "usr_owner",
          toolId: "queryView",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );

    expect(directResponse.status).toBe(200);
    expect(agentResponse.status).toBe(200);

    const directBody = (await directResponse.json()) as {
      rows: Array<{ cells: Record<string, unknown>; recordId: string }>;
    };
    const agentBody = (await agentResponse.json()) as {
      output: {
        kind: string;
        view: Record<string, unknown>;
      };
    };

    expect(directBody.rows).toEqual([
      {
        cells: {
          fld_owner: ["usr_owner"],
          fld_title: "Owned by owner"
        },
        hiddenFieldIds: [],
        recordId: "rec_owner_smoke_1",
        recordKey: "owner-smoke-1",
        redactedFieldIds: [],
        states: {
          fld_owner: "visible",
          fld_title: "visible"
        }
      }
    ]);
    expect(agentBody.output).toEqual({
      kind: "view-query",
      view: directBody
    });
  });

  it("proves the canonical row.owner workflow creation through the audited execute smoke path", async () => {
    const { db, env } = createEnv();

    insertPermissionSnapshot(db, {
      commandTypes: ["field.create", "workflow.create", "workflow.publish"],
      fields: {
        fld_owner: {
          agent: true,
          fieldId: "fld_owner",
          fieldType: "principal.user",
          read: "visible",
          workflow: true,
          write: true
        }
      },
      policyRevision: 46,
      principalId: "usr_owner_execute",
      scopeHash: "scope:table:tbl_1"
    });

    const createOwnerField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_owner_execute_smoke",
            idempotencyKey: "idem_field_owner_execute_smoke",
            payload: {
              config: {
                rowOwner: true
              },
              fieldId: "fld_owner",
              fieldKey: "owner",
              fieldType: "principal.user",
              label: "Owner"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createOwnerField.status).toBe(200);

    const previewResponse = await handleFetch(
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
            name: "Owner assigned execute smoke",
            tableId: "tbl_1",
            triggerId: "field_changed",
            workflowId: "wf_owner_assigned_execute_smoke"
          },
          permissionScopeHash: "scope:table:tbl_1",
          policyRevision: 46,
          principalId: "usr_owner_execute",
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
      };
    };

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
          principalId: "usr_owner_execute",
          toolId: "executeCommand",
          workspaceId: "ws_1"
        })
      }),
      env,
      {} as ExecutionContext
    );
    expect(executeResponse.status).toBe(200);
    expect(
      (await executeResponse.json()) as {
        output: {
          command: CommandEnvelope;
          result: {
            accepted: boolean;
            events: Array<{ commandType: string; eventType: string }>;
            status: string;
          };
        };
      }
    ).toMatchObject({
      output: {
        command: {
          actor: {
            mode: "agent",
            principalId: "usr_owner_execute"
          },
          commandType: "workflow.create",
          payload: {
            definition: {
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
            },
            workflowId: "wf_owner_assigned_execute_smoke"
          }
        },
        result: {
          accepted: true,
          events: [
            {
              commandType: "workflow.create",
              eventType: "workflow.created"
            }
          ],
          status: "accepted"
        }
      }
    });
    const definitionResponse = await handleFetch(
      new Request(
        "https://example.test/v1/workflows/wf_owner_assigned_execute_smoke/definition?workspaceId=ws_1&principalId=usr_owner_execute&permissionScopeHash=scope:table:tbl_1&policyRevision=46"
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
      },
      workflow: {
        bindings: {
          "row.owner": {
            binding: "row.owner",
            fieldId: "fld_owner",
            fieldType: "principal.user",
            template: {
              fieldIdPath: "row.owner.fieldId",
              fieldTypePath: "row.owner.fieldType",
              valuePath: "row.owner.value"
            }
          }
        }
      },
      workflowId: "wf_owner_assigned_execute_smoke"
    });
  });

  it("fans committed events into projection maintenance queue work", async () => {
    const { db, env, eventFanoutQueue, projectionQueue } = createEnv();

    const createField = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/fields", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_field_status_1",
            idempotencyKey: "idem_field_status_1",
            payload: {
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "text.single_line",
              label: "Status"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createField.status).toBe(200);

    const createRecord = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_record_status_1",
            idempotencyKey: "idem_record_status_1",
            payload: {
              recordId: "rec_1"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createRecord.status).toBe(200);

    const createView = await handleFetch(
      new Request("https://example.test/v1/commands/execute", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_view_status_1",
            commandType: "view.create",
            idempotencyKey: "idem_view_status_1",
            payload: {
              filterFieldIds: ["fld_status"],
              groupByFieldId: null,
              sortFieldIds: ["fld_status"],
              viewId: "view_status",
              viewName: "Status",
              visibleFieldIds: ["fld_status"]
            },
            scope: "workspace",
            tableId: "tbl_1"
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(createView.status).toBe(200);
    eventFanoutQueue.sent.length = 0;

    const setCell = await handleFetch(
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
              value: "processed"
            }
          })
        )
      }),
      env,
      {} as ExecutionContext
    );
    expect(setCell.status).toBe(200);
    expect(eventFanoutQueue.sent).toHaveLength(1);

    await handleQueueBatch(
      createBatch([eventFanoutQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );
    expect(projectionQueue.sent).toHaveLength(1);

    await handleQueueBatch(
      createBatch([projectionQueue.sent[0]!]).batch as never,
      env,
      {} as ExecutionContext
    );

    const indexRows = await db
      .prepare(
        `SELECT field_id, record_id, index_value_text
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ?`
      )
      .bind("ws_1", "tbl_1")
      .all<{
        field_id: string;
        index_value_text: string | null;
        record_id: string;
      }>();

    expect(indexRows.results).toEqual([
      {
        field_id: "fld_status",
        index_value_text: "processed",
        record_id: "rec_1"
      }
    ]);
  });

  it("recovers queued outbox work after a post-commit publish failure", async () => {
    const { db, env, eventFanoutQueue } = createEnv();
    eventFanoutQueue.failNext();

    const response = await handleFetch(
      new Request("https://example.test/v1/tables/tbl_1/records", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify(
          createRouteBody({
            commandId: "cmd_recovery_1",
            commandType: "record.create",
            idempotencyKey: "idem_recovery_1",
            payload: {
              recordId: "rec_recovery_1"
            }
          })
        )
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

    const outbox = db.inner
      .prepare(
        `SELECT delivered_at, delivery_attempts
         FROM queue_outbox
         WHERE event_id = ?`
      )
      .get(body.result.events[0]!.eventId) as {
      delivered_at: string | null;
      delivery_attempts: number;
    };
    expect(outbox.delivery_attempts).toBe(2);
    expect(outbox.delivered_at).not.toBeNull();
  });
});
