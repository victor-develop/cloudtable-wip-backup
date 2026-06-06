import { describe, expect, it } from "vitest";

import { TableCoordinatorDurableObject } from "../../../../src/durable-objects/table-coordinator";
import { WorkspaceControlDurableObject } from "../../../../src/durable-objects/workspace-control";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
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
    commandType: "records.upsert",
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

function createEnv(): {
  db: SqliteD1Database;
  env: CloudTableEnv;
  eventFanoutQueue: FakeQueue;
} {
  const db = new SqliteD1Database();
  seedWorkspace(db, "ws_1");
  seedAppAndTable(db, {
    workspaceId: "ws_1",
    tableId: "tbl_1"
  });

  const eventFanoutQueue = new FakeQueue();
  const workflowQueue = new FakeQueue();
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
    WORKSPACE_CONTROL_DO: workspaceNamespace as unknown as DurableObjectNamespace
  };

  return {
    db,
    env,
    eventFanoutQueue
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
});
