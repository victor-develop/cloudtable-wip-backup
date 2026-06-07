import { describe, expect, it } from "vitest";

import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
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

  async send(message: CloudTableQueueMessage): Promise<void> {
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
    projectionQueue
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
});
