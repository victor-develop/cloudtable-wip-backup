import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { createEventLedger } from "../../../../src/core/events/event-ledger";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { AgentToolDefinition } from "../../../../src/core/agent-tools/types";
import { createCloudTableD1Repository } from "../../../../src/core/persistence/cloudtable-d1-repository";
import type {
  EffectivePermissionSnapshot,
  PermissionEngine,
  PermissionFieldDescriptor,
  PermissionProjectionInput,
  PermissionSurface
} from "../../../../src/core/permissions/types";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";

type QueryResults<T> = {
  results: T[];
};

type SqlParameter = string | number | bigint | Uint8Array | DataView | null;

function createAcceptedResult(logicalTime: string): CommandResult {
  return {
    accepted: true,
    diagnostics: [],
    events: [],
    permission: {
      allowed: true,
      reasons: []
    },
    replayProjection: {
      acceptedCommandIds: [],
      lastLogicalTime: logicalTime,
      receiptCount: 0,
      receipts: []
    },
    sideEffects: [],
    status: "accepted"
  };
}

function createPermissionEngineStub(): PermissionEngine {
  return {
    describeField() {
      return {
        allowsMutation: true,
        allowsWorkflowTrigger: true,
        readRedaction: "none",
        supportsValueVisibilityRules: false
      };
    },
    evaluateCommand() {
      return {
        allowed: true,
        reasons: []
      };
    },
    evaluateFieldAccess(field: PermissionFieldDescriptor) {
      return {
        allowed: true,
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        readState: "visible",
        reasons: [],
        writeAllowed: true
      };
    },
    filterAgentTools(tools: readonly AgentToolDefinition[]) {
      return tools.map((tool) => ({
        allowed: true,
        hiddenFieldIds: [],
        reason: null,
        toolId: tool.id,
        visibleFieldIds: []
      }));
    },
    resolveAgentToolFieldVisibility() {
      return {
        hiddenFieldIds: [],
        visibleFieldIds: [],
        writableFieldIds: []
      };
    },
    listSurfaces() {
      return [
        "command-ingress",
        "direct-record-read",
        "view-query",
        "workflow-step",
        "agent-tool"
      ];
    },
    projectFields(fields: readonly PermissionProjectionInput[]) {
      return {
        diagnostics: [],
        fields: Object.fromEntries(fields.map((field) => [field.fieldId, field.value])),
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: Object.fromEntries(fields.map((field) => [field.fieldId, "visible"]))
      };
    }
  };
}

class SqliteD1BoundStatement {
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync,
    private readonly params: SqlParameter[]
  ) {}

  async all<T>(): Promise<QueryResults<T>> {
    return {
      results: this.statement.all(...(this.params as Parameters<StatementSync["all"]>)) as T[]
    };
  }

  async first<T>(): Promise<T | null> {
    const row = this.statement.get(...(this.params as Parameters<StatementSync["get"]>)) as
      | T
      | undefined;
    return row ?? null;
  }

  execute(): QueryResults<unknown> {
    const sql = this.sql.trimStart().toUpperCase();

    if (
      sql.startsWith("INSERT") ||
      sql.startsWith("UPDATE") ||
      sql.startsWith("DELETE") ||
      sql.startsWith("CREATE") ||
      sql.startsWith("DROP") ||
      sql.startsWith("ALTER")
    ) {
      this.statement.run(...(this.params as Parameters<StatementSync["run"]>));
      return {
        results: []
      };
    }

    return {
      results: this.statement.all(...(this.params as Parameters<StatementSync["all"]>))
    };
  }
}

class SqliteD1PreparedStatement {
  constructor(
    private readonly sql: string,
    private readonly statement: StatementSync
  ) {}

  bind(...params: SqlParameter[]): SqliteD1BoundStatement {
    return new SqliteD1BoundStatement(this.sql, this.statement, params);
  }
}

class SqliteD1Database {
  readonly inner = new DatabaseSync(":memory:");

  constructor() {
    this.inner.exec(
      readFileSync(resolve(process.cwd(), "migrations/0001_initial_schema.sql"), "utf8")
    );
    this.inner
      .prepare(
        `INSERT INTO workspaces (
          id,
          slug,
          name,
          created_at,
          updated_at,
          archived_at,
          last_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        "ws_1",
        "workspace-1",
        "Workspace 1",
        "2026-06-06T00:00:00.000Z",
        "2026-06-06T00:00:00.000Z",
        null,
        null
      );
  }

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(sql, this.inner.prepare(sql));
  }

  async batch(statements: Array<SqliteD1BoundStatement>): Promise<Array<QueryResults<unknown>>> {
    this.inner.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.inner.exec("COMMIT");
      return results;
    } catch (error) {
      this.inner.exec("ROLLBACK");
      throw error;
    }
  }
}

function createDatabase(): SqliteD1Database {
  return new SqliteD1Database();
}

function createBaseCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
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

describe("cloudtable D1 repository", () => {
  it("commits event, receipt, outbox, and projection rows in one repository path", async () => {
    const db = createDatabase();
    const repository = createCloudTableD1Repository(db as unknown as D1Database);

    const result = await repository.commitAcceptedCommand({
      scopeKey: "ws_1:table:tbl_1",
      command: createBaseCommand(),
      event: {
        commandId: "cmd_1",
        commandType: "records.upsert",
        createdAt: "2026-06-06T00:00:00.000Z",
        eventId: "evt_1",
        eventType: "scaffold.command.accepted",
        metadata: {
          actor: {
            mode: "user",
            principalId: "principal_1"
          },
          scope: "table"
        },
        payload: {
          recordId: "rec_1"
        },
        tableId: "tbl_1",
        workspaceId: "ws_1"
      },
      receipt: {
        idempotencyKey: "idem_1",
        payloadHash: "{\"sample\":true}",
        result: createAcceptedResult("2026-06-06T00:00:00.000Z")
      }
    });

    expect(result.event.metadata).toMatchObject({
      tableSequence: 1,
      workspaceSequence: 1
    });
    expect(result.receipts).toHaveLength(1);

    const outboxRows = await repository.listOutboxEntriesForEvent("evt_1");
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0]).toMatchObject({
      event_id: "evt_1",
      queue_name: "event-fanout",
      workspace_id: "ws_1"
    });

    const projectionRows = await db
      .prepare(
        `SELECT projection_version, last_event_id
         FROM record_projection
         WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_1", "rec_1")
      .all<{ projection_version: number; last_event_id: string }>();

    expect(projectionRows.results).toEqual([
      {
        last_event_id: "evt_1",
        projection_version: 1
      }
    ]);
  });

  it("advances workspace and table sequences across accepted commits", async () => {
    const db = createDatabase();
    const repository = createCloudTableD1Repository(db as unknown as D1Database);

    const first = await repository.commitAcceptedCommand({
      scopeKey: "ws_1:table:tbl_1",
      command: createBaseCommand(),
      event: {
        commandId: "cmd_1",
        commandType: "records.upsert",
        createdAt: "2026-06-06T00:00:00.000Z",
        eventId: "evt_1",
        eventType: "scaffold.command.accepted",
        metadata: {},
        payload: {
          recordId: "rec_1"
        },
        tableId: "tbl_1",
        workspaceId: "ws_1"
      },
      receipt: {
        idempotencyKey: "idem_1",
        payloadHash: "hash_1",
        result: createAcceptedResult("2026-06-06T00:00:00.000Z")
      }
    });

    const second = await repository.commitAcceptedCommand({
      scopeKey: "ws_1:table:tbl_1",
      command: createBaseCommand({
        commandId: "cmd_2",
        idempotencyKey: "idem_2",
        payload: {
          recordId: "rec_2"
        }
      }),
      event: {
        commandId: "cmd_2",
        commandType: "records.upsert",
        createdAt: "2026-06-06T00:00:01.000Z",
        eventId: "evt_2",
        eventType: "scaffold.command.accepted",
        metadata: {},
        payload: {
          recordId: "rec_2"
        },
        tableId: "tbl_1",
        workspaceId: "ws_1"
      },
      receipt: {
        idempotencyKey: "idem_2",
        payloadHash: "hash_2",
        result: createAcceptedResult("2026-06-06T00:00:01.000Z")
      }
    });

    expect(first.event.metadata).toMatchObject({
      tableSequence: 1,
      workspaceSequence: 1
    });
    expect(second.event.metadata).toMatchObject({
      tableSequence: 2,
      workspaceSequence: 2
    });
  });

  it("replays matching idempotency keys through the command bus without duplicating commits", async () => {
    const db = createDatabase();
    const eventLedger = createEventLedger(db as unknown as D1Database);
    const fieldTypeRegistry = createFieldTypeRegistry();
    const permissionEngine = createPermissionEngineStub();
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: () => "evt_1",
      now: () => "2026-06-06T00:00:00.000Z",
      permissionEngine,
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    const command = createBaseCommand();

    const first = await commandBus.execute(command);
    const second = await commandBus.execute(command);

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(second.diagnostics).toEqual(["idempotent_replay"]);

    const eventRows = await db
      .prepare(
        `SELECT event_id
         FROM event_ledger
         WHERE workspace_id = ?`
      )
      .bind("ws_1")
      .all<{ event_id: string }>();

    const outboxRows = await db
      .prepare(
        `SELECT outbox_id
         FROM queue_outbox
         WHERE workspace_id = ?`
      )
      .bind("ws_1")
      .all<{ outbox_id: string }>();

    expect(eventRows.results).toEqual([{ event_id: "evt_1" }]);
    expect(outboxRows.results).toEqual([{ outbox_id: "outbox:evt_1:event-fanout" }]);
  });
});
