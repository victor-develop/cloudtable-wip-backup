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

function createRecordCreateCommand(overrides: Partial<CommandEnvelope> = {}): CommandEnvelope {
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

function seedTableForRecordCommits(db: SqliteD1Database, tableId = "tbl_1"): void {
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
      "base_1",
      "ws_1",
      "base-1",
      "Base 1",
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      "evt_seed_base"
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
      tableId,
      "ws_1",
      "base_1",
      "table-1",
      "Table 1",
      0,
      1,
      "2026-06-06T00:00:00.000Z",
      "2026-06-06T00:00:00.000Z",
      null,
      "evt_seed_table"
    );
}

function createDomainCommand(
  commandType: CommandEnvelope["commandType"],
  overrides: Partial<CommandEnvelope> = {}
): CommandEnvelope {
  const defaults: Record<string, CommandEnvelope> = {
    "base.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_base_1",
      commandType: "base.create",
      idempotencyKey: "idem_base_1",
      payload: {
        baseId: "base_1",
        name: "Support Ops",
        slug: "support-ops"
      },
      scope: "workspace",
      workspaceId: "ws_1"
    },
    "table.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_table_1",
      commandType: "table.create",
      idempotencyKey: "idem_table_1",
      payload: {
        baseId: "base_1",
        name: "Tickets",
        slug: "tickets",
        tableId: "tbl_tickets"
      },
      scope: "workspace",
      workspaceId: "ws_1"
    },
    "field.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_field_1",
      commandType: "field.create",
      idempotencyKey: "idem_field_1",
      payload: {
        config: {},
        fieldId: "fld_title",
        fieldKey: "title",
        fieldType: "text.single_line",
        label: "Title"
      },
      scope: "workspace",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "field.update": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_field_update_1",
      commandType: "field.update",
      idempotencyKey: "idem_field_update_1",
      payload: {
        config: {
          options: []
        },
        fieldId: "fld_title"
      },
      scope: "workspace",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "record.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_record_1",
      commandType: "record.create",
      idempotencyKey: "idem_record_1",
      payload: {
        recordId: "rec_1"
      },
      scope: "table",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "record.update": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_record_update_1",
      commandType: "record.update",
      idempotencyKey: "idem_record_update_1",
      payload: {
        patch: {
          title: "Updated case"
        },
        recordId: "rec_1"
      },
      scope: "table",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "record.archive": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_record_archive_1",
      commandType: "record.archive",
      idempotencyKey: "idem_record_archive_1",
      payload: {
        recordId: "rec_1"
      },
      scope: "table",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "cell.set": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_cell_1",
      commandType: "cell.set",
      idempotencyKey: "idem_cell_1",
      payload: {
        fieldId: "fld_title",
        recordId: "rec_1",
        value: "Escalated case"
      },
      scope: "table",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "field.permission.configure": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_field_permission_1",
      commandType: "field.permission.configure",
      idempotencyKey: "idem_field_permission_1",
      payload: {
        fieldId: "fld_title",
        policy: {
          agent: false,
          read: "redacted",
          workflow: true,
          write: false
        },
        principalId: "usr_member"
      },
      scope: "workspace",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "view.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_view_1",
      commandType: "view.create",
      idempotencyKey: "idem_view_1",
      payload: {
        filterFieldIds: [],
        sortFieldIds: [],
        viewId: "view_tickets",
        viewKey: "tickets",
        viewName: "Tickets",
        visibleFieldIds: ["fld_title"]
      },
      scope: "workspace",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "view.update": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_view_update_1",
      commandType: "view.update",
      idempotencyKey: "idem_view_update_1",
      payload: {
        filterFieldIds: [],
        sortFieldIds: ["fld_title"],
        viewId: "view_tickets",
        viewName: "Tickets Revised",
        visibleFieldIds: ["fld_title"]
      },
      scope: "workspace",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "workflow.create": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_workflow_create_1",
      commandType: "workflow.create",
      idempotencyKey: "idem_workflow_create_1",
      payload: {
        definition: {
          actions: [
            {
              input: {
                fieldId: "fld_title",
                fieldType: "text.single_line",
                recordId: {
                  path: "row.recordId"
                },
                tableId: {
                  path: "table.tableId"
                },
                value: "Escalated case"
              },
              operatorId: "set_cell"
            }
          ],
          conditions: [],
          metadata: {
            status: "draft",
            tableId: "tbl_tickets"
          },
          principal: {
            policyRevision: 7,
            principalId: "wf_service",
            schemaEpoch: 1,
            scopeHash: "scope:wf:tickets"
          },
          trigger: {
            match: {
              tableId: "tbl_tickets"
            },
            operatorId: "record_updated"
          },
          workflowId: "wf_ticket_escalation"
        },
        name: "Ticket Escalation",
        tableId: "tbl_tickets",
        workflowId: "wf_ticket_escalation",
        workflowKey: "ticket-escalation"
      },
      scope: "workflow",
      tableId: "tbl_tickets",
      workspaceId: "ws_1"
    },
    "workflow.publish": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_workflow_publish_1",
      commandType: "workflow.publish",
      idempotencyKey: "idem_workflow_publish_1",
      payload: {
        workflowId: "wf_ticket_escalation"
      },
      scope: "workflow",
      workspaceId: "ws_1"
    },
    "workflow.pause": {
      actor: {
        mode: "user",
        principalId: "principal_1"
      },
      commandId: "cmd_workflow_pause_1",
      commandType: "workflow.pause",
      idempotencyKey: "idem_workflow_pause_1",
      payload: {
        workflowId: "wf_ticket_escalation"
      },
      scope: "workflow",
      workspaceId: "ws_1"
    }
  };

  return {
    ...defaults[commandType],
    ...overrides,
    payload: {
      ...defaults[commandType].payload,
      ...(overrides.payload ?? {})
    }
  };
}

describe("cloudtable D1 repository", () => {
  it("persists the base/table/field/record/cell vertical slice transactionally", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_domain_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:00:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    const commands = [
      createDomainCommand("base.create"),
      createDomainCommand("table.create"),
      createDomainCommand("field.create"),
      createDomainCommand("record.create"),
      createDomainCommand("cell.set")
    ];

    for (const command of commands) {
      const result = await commandBus.execute(command);
      expect(result.status).toBe("accepted");
    }

    const appRows = await db
      .prepare(`SELECT id, slug, name FROM apps WHERE workspace_id = ?`)
      .bind("ws_1")
      .all<{ id: string; name: string; slug: string }>();
    expect(appRows.results).toEqual([
      {
        id: "base_1",
        name: "Support Ops",
        slug: "support-ops"
      }
    ]);

    const tableRows = await db
      .prepare(`SELECT id, app_id, slug, name FROM tables WHERE workspace_id = ?`)
      .bind("ws_1")
      .all<{ app_id: string; id: string; name: string; slug: string }>();
    expect(tableRows.results).toEqual([
      {
        app_id: "base_1",
        id: "tbl_tickets",
        name: "Tickets",
        slug: "tickets"
      }
    ]);

    const fieldRows = await db
      .prepare(
        `SELECT id, field_key, field_type
         FROM fields
         WHERE workspace_id = ? AND table_id = ?`
      )
      .bind("ws_1", "tbl_tickets")
      .all<{ field_key: string; field_type: string; id: string }>();
    expect(fieldRows.results).toEqual([
      {
        field_key: "title",
        field_type: "text.single_line",
        id: "fld_title"
      }
    ]);

    const recordRows = await db
      .prepare(
        `SELECT id, record_revision, last_event_id
         FROM records
         WHERE workspace_id = ? AND table_id = ?`
      )
      .bind("ws_1", "tbl_tickets")
      .all<{ id: string; last_event_id: string; record_revision: number }>();
    expect(recordRows.results).toEqual([
      {
        id: "rec_1",
        last_event_id: "evt_domain_5",
        record_revision: 1
      }
    ]);

    const cellRows = await db
      .prepare(
        `SELECT display_value, search_text, cell_revision
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1", "fld_title")
      .all<{ cell_revision: number; display_value: string; search_text: string }>();
    expect(cellRows.results).toEqual([
      {
        cell_revision: 1,
        display_value: "Escalated case",
        search_text: "escalated case"
      }
    ]);

    const projectionRows = await db
      .prepare(
        `SELECT projection_json, projection_version
         FROM record_projection
         WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{ projection_json: string; projection_version: number }>();
    expect(projectionRows.results).toEqual([
      {
        projection_json: JSON.stringify(
          {
            fields: {
              title: "Escalated case"
            }
          },
          null,
          2
        ),
        projection_version: 2
      }
    ]);
  });

  it("persists field permission configuration into field config, policy bindings, and snapshots", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_perm_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:01:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(createDomainCommand("field.create"));

    const result = await commandBus.execute(createDomainCommand("field.permission.configure"));
    expect(result.status).toBe("accepted");
    expect(result.events[0]?.eventType).toBe("field.permission.configured");

    const fieldRow = db.inner
      .prepare(`SELECT config_json, last_event_id FROM fields WHERE workspace_id = ? AND id = ?`)
      .get("ws_1", "fld_title") as { config_json: string; last_event_id: string };
    const fieldConfig = JSON.parse(fieldRow.config_json) as {
      permissionsByPrincipal: Record<string, unknown>;
    };
    expect(fieldConfig.permissionsByPrincipal.usr_member).toEqual({
      agent: false,
      read: "redacted",
      workflow: true,
      write: false
    });
    expect(fieldRow.last_event_id).toBe("evt_perm_4");

    const policyRow = db.inner
      .prepare(
        `SELECT revision, policy_json
         FROM permission_policies
         WHERE workspace_id = ?
         ORDER BY revision DESC
         LIMIT 1`
      )
      .get("ws_1") as { policy_json: string; revision: number };
    expect(policyRow.revision).toBe(1);
    expect(JSON.parse(policyRow.policy_json)).toMatchObject({
      fieldId: "fld_title",
      kind: "field_permission_configuration",
      principalId: "usr_member",
      tableId: "tbl_tickets"
    });

    const bindingRow = db.inner
      .prepare(
        `SELECT revision, binding_json
         FROM permission_policy_bindings
         WHERE workspace_id = ?
         ORDER BY revision DESC
         LIMIT 1`
      )
      .get("ws_1") as { binding_json: string; revision: number };
    expect(bindingRow.revision).toBe(1);
    expect(JSON.parse(bindingRow.binding_json)).toMatchObject({
      principalId: "usr_member",
      scopeHash: "scope:table:tbl_tickets"
    });

    const snapshotRow = db.inner
      .prepare(
        `SELECT principal_id, policy_revision, scope_hash, snapshot_json
         FROM permission_snapshots
         WHERE workspace_id = ?
         ORDER BY policy_revision DESC
         LIMIT 1`
      )
      .get("ws_1") as {
      policy_revision: number;
      principal_id: string;
      scope_hash: string;
      snapshot_json: string;
    };
    expect(snapshotRow.principal_id).toBe("usr_member");
    expect(snapshotRow.policy_revision).toBe(1);
    expect(snapshotRow.scope_hash).toBe("scope:table:tbl_tickets");
    expect(JSON.parse(snapshotRow.snapshot_json)).toMatchObject({
      fields: {
        fld_title: {
          agent: false,
          read: "redacted",
          workflow: true,
          write: false
        }
      },
      principalId: "usr_member",
      schemaEpoch: 0
    });
  });

  it("validates configured status options and stores label-aware cell projections", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_status_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:02:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    const statusConfig = {
      options: [
        { id: "todo", label: "Todo", semantic: "todo" },
        { id: "in_progress", label: "In Progress", semantic: "in_progress" },
        { id: "done", label: "Done", semantic: "done" }
      ]
    };

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));

    const createFieldResult = await commandBus.execute(
      createDomainCommand("field.create", {
        commandId: "cmd_field_status_1",
        idempotencyKey: "idem_field_status_1",
        payload: {
          config: statusConfig,
          fieldId: "fld_status",
          fieldKey: "status",
          fieldType: "status.semantic",
          label: "Status"
        }
      })
    );
    expect(createFieldResult.status).toBe("accepted");

    const createRecordResult = await commandBus.execute(
      createDomainCommand("record.create", {
        commandId: "cmd_record_status_1",
        idempotencyKey: "idem_record_status_1",
        payload: {
          cells: {
            fld_status: "in_progress"
          },
          recordId: "rec_status_1"
        }
      })
    );
    expect(createRecordResult.status).toBe("accepted");

    const cellRow = db.inner
      .prepare(
        `SELECT display_value, search_text, number_value
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_tickets", "rec_status_1", "fld_status") as {
      display_value: string;
      number_value: number | null;
      search_text: string;
    };
    expect(cellRow).toEqual({
      display_value: "In Progress",
      number_value: 1,
      search_text: "in progress in_progress"
    });

    const rejectedWrite = await commandBus.execute(
      createDomainCommand("cell.set", {
        commandId: "cmd_status_invalid_1",
        idempotencyKey: "idem_status_invalid_1",
        payload: {
          fieldId: "fld_status",
          recordId: "rec_status_1",
          value: "missing"
        }
      })
    );
    expect(rejectedWrite.status).toBe("rejected");
    expect(rejectedWrite.diagnostics).toEqual([
      "Unknown option id for status.semantic: missing."
    ]);

    const invalidFieldConfig = await commandBus.execute(
      createDomainCommand("field.create", {
        commandId: "cmd_field_status_invalid_cfg",
        idempotencyKey: "idem_field_status_invalid_cfg",
        payload: {
          config: {
            options: [{ id: "todo", label: "Todo" }]
          },
          fieldId: "fld_status_invalid_cfg",
          fieldKey: "status_invalid_cfg",
          fieldType: "status.semantic",
          label: "Status Invalid"
        }
      })
    );
    expect(invalidFieldConfig.status).toBe("rejected");
    expect(invalidFieldConfig.diagnostics).toEqual([
      "invalid_field_config:status.semantic:Status option todo is missing a semantic value."
    ]);
  });

  it("backfills status cell and index projections when option metadata changes", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_field_update_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:03:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(
      createDomainCommand("field.create", {
        commandId: "cmd_field_status_backfill_create",
        idempotencyKey: "idem_field_status_backfill_create",
        payload: {
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
          label: "Status"
        }
      })
    );
    await commandBus.execute(
      createDomainCommand("view.create", {
        commandId: "cmd_view_status_backfill_create",
        idempotencyKey: "idem_view_status_backfill_create",
        payload: {
          filterFieldIds: ["fld_status"],
          sortFieldIds: ["fld_status"],
          viewId: "view_status_backfill",
          viewKey: "status-backfill",
          viewName: "Status Backfill",
          visibleFieldIds: ["fld_status"]
        }
      })
    );
    await commandBus.execute(
      createDomainCommand("record.create", {
        commandId: "cmd_record_status_backfill",
        idempotencyKey: "idem_record_status_backfill",
        payload: {
          cells: {
            fld_status: "in_progress"
          },
          recordId: "rec_status_backfill"
        }
      })
    );

    const result = await commandBus.execute(
      createDomainCommand("field.update", {
        commandId: "cmd_field_status_backfill_update",
        idempotencyKey: "idem_field_status_backfill_update",
        payload: {
          config: {
            options: [
              { id: "done", label: "Done", semantic: "done" },
              { id: "in_progress", label: "Working", semantic: "in_progress" },
              { id: "todo", label: "Queued", semantic: "todo" }
            ]
          },
          fieldId: "fld_status"
        }
      })
    );
    expect(result.status).toBe("accepted");
    const updateEventId = result.events[0]?.eventId as string;

    const cellRow = db.inner
      .prepare(
        `SELECT display_value, search_text, number_value, value_json, last_event_id
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_tickets", "rec_status_backfill", "fld_status") as {
      display_value: string;
      last_event_id: string;
      number_value: number | null;
      search_text: string;
      value_json: string;
    };
    expect(cellRow.display_value).toBe("Working");
    expect(cellRow.search_text).toBe("working in_progress");
    expect(cellRow.number_value).toBe(1);
    expect(cellRow.last_event_id).toBe(updateEventId);
    expect(JSON.parse(cellRow.value_json)).toMatchObject({
      meta: {
        optionId: "in_progress",
        optionLabel: "Working",
        optionOrder: 1
      },
      raw: "in_progress"
    });

    const indexRow = db.inner
      .prepare(
        `SELECT index_value_text, index_value_number, last_event_id
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
      )
      .get("ws_1", "tbl_tickets", "fld_status", "rec_status_backfill") as {
      index_value_number: number | null;
      index_value_text: string | null;
      last_event_id: string;
    };
    expect(indexRow).toEqual({
      index_value_number: 1,
      index_value_text: "Working",
      last_event_id: updateEventId
    });
  });

  it("updates saved-view definitions by versioning schema history and current view state", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_view_update_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:05:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(createDomainCommand("field.create"));
    await commandBus.execute(
      createDomainCommand("field.create", {
        commandId: "cmd_field_status_for_view_update",
        idempotencyKey: "idem_field_status_for_view_update",
        payload: {
          config: {
            options: [
              { id: "todo", label: "Todo", semantic: "todo" },
              { id: "done", label: "Done", semantic: "done" }
            ]
          },
          fieldId: "fld_status",
          fieldKey: "status",
          fieldType: "status.semantic",
          label: "Status"
        }
      })
    );
    await commandBus.execute(
      createDomainCommand("view.create", {
        commandId: "cmd_view_create_for_update",
        idempotencyKey: "idem_view_create_for_update",
        payload: {
          filterFieldIds: [],
          sortFieldIds: ["fld_title"],
          viewId: "view_tickets",
          viewKey: "tickets",
          viewName: "Tickets",
          visibleFieldIds: ["fld_title"]
        }
      })
    );

    const result = await commandBus.execute(
      createDomainCommand("view.update", {
        commandId: "cmd_view_update_for_update",
        idempotencyKey: "idem_view_update_for_update",
        payload: {
          filters: [
            {
              fieldId: "fld_status",
              operatorId: "equals",
              value: "done"
            }
          ],
          groupByFieldId: "fld_status",
          sorts: [
            {
              fieldId: "fld_status",
              mode: "descending"
            }
          ],
          viewId: "view_tickets",
          viewName: "Tickets Revised",
          visibleFieldIds: ["fld_title", "fld_status"]
        }
      })
    );

    expect(result).toMatchObject({
      accepted: true,
      events: [
        {
          aggregateId: "view_tickets",
          aggregateType: "view",
          commandType: "view.update",
          eventType: "view.updated"
        }
      ],
      status: "accepted"
    });

    const viewRow = db.inner
      .prepare(
        `SELECT name, current_schema_version, last_event_id
         FROM views
         WHERE workspace_id = ? AND table_id = ? AND id = ?`
      )
      .get("ws_1", "tbl_tickets", "view_tickets") as {
      current_schema_version: number;
      last_event_id: string;
      name: string;
    };
    expect(viewRow).toEqual({
      current_schema_version: 2,
      last_event_id: "evt_view_update_6",
      name: "Tickets Revised"
    });

    const schemaRows = db.inner
      .prepare(
        `SELECT schema_version, schema_json
         FROM view_schema_versions
         WHERE workspace_id = ? AND view_id = ?
         ORDER BY schema_version ASC`
      )
      .all("ws_1", "view_tickets") as Array<{
      schema_json: string;
      schema_version: number;
    }>;
    expect(schemaRows).toHaveLength(2);
    expect(schemaRows.map((row) => row.schema_version)).toEqual([1, 2]);
    expect(JSON.parse(schemaRows[1]!.schema_json)).toEqual({
      filterFieldIds: ["fld_status"],
      filters: [
        {
          fieldId: "fld_status",
          operatorId: "equals",
          value: "done"
        }
      ],
      groupByFieldId: "fld_status",
      sortFieldIds: ["fld_status"],
      sorts: [
        {
          fieldId: "fld_status",
          mode: "descending"
        }
      ],
      visibleFieldIds: ["fld_title", "fld_status"]
    });
  });

  it("preserves removed multi-select ids while reordering known options during backfill", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_multi_update_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:04:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(
      createDomainCommand("field.create", {
        commandId: "cmd_field_tags_create",
        idempotencyKey: "idem_field_tags_create",
        payload: {
          config: {
            options: [
              { id: "alpha", label: "Alpha" },
              { id: "beta", label: "Beta" },
              { id: "gamma", label: "Gamma" }
            ]
          },
          fieldId: "fld_tags",
          fieldKey: "tags",
          fieldType: "select.multi",
          label: "Tags"
        }
      })
    );
    await commandBus.execute(
      createDomainCommand("view.create", {
        commandId: "cmd_view_tags_create",
        idempotencyKey: "idem_view_tags_create",
        payload: {
          sortFieldIds: ["fld_tags"],
          viewId: "view_tags_backfill",
          viewKey: "tags-backfill",
          viewName: "Tags Backfill",
          visibleFieldIds: ["fld_tags"]
        }
      })
    );
    await commandBus.execute(
      createDomainCommand("record.create", {
        commandId: "cmd_record_tags_create",
        idempotencyKey: "idem_record_tags_create",
        payload: {
          cells: {
            fld_tags: ["alpha", "gamma"]
          },
          recordId: "rec_tags_backfill"
        }
      })
    );

    const result = await commandBus.execute(
      createDomainCommand("field.update", {
        commandId: "cmd_field_tags_update",
        idempotencyKey: "idem_field_tags_update",
        payload: {
          config: {
            options: [
              { id: "gamma", label: "Gamma" },
              { id: "beta", label: "Beta" }
            ]
          },
          fieldId: "fld_tags"
        }
      })
    );
    expect(result.status).toBe("accepted");
    const updateEventId = result.events[0]?.eventId as string;

    const cellRow = db.inner
      .prepare(
        `SELECT display_value, search_text, value_json
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ? AND field_id = ?`
      )
      .get("ws_1", "tbl_tickets", "rec_tags_backfill", "fld_tags") as {
      display_value: string;
      search_text: string;
      value_json: string;
    };
    expect(cellRow.display_value).toBe("Gamma, alpha");
    expect(cellRow.search_text).toBe("gamma alpha");
    expect(JSON.parse(cellRow.value_json)).toMatchObject({
      raw: ["gamma", "alpha"]
    });

    const indexRow = db.inner
      .prepare(
        `SELECT index_value_text, last_event_id
         FROM field_index_entries
         WHERE workspace_id = ? AND table_id = ? AND field_id = ? AND record_id = ?`
      )
      .get("ws_1", "tbl_tickets", "fld_tags", "rec_tags_backfill") as {
      index_value_text: string | null;
      last_event_id: string;
    };
    expect(indexRow).toEqual({
      index_value_text: "Gamma, alpha",
      last_event_id: updateEventId
    });
  });

  it("persists record.update and record.archive across row state and projections", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_domain_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:01:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    const setupCommands = [
      createDomainCommand("base.create"),
      createDomainCommand("table.create"),
      createDomainCommand("field.create"),
      createDomainCommand("record.create"),
      createDomainCommand("cell.set"),
      createDomainCommand("record.update")
    ];

    for (const command of setupCommands) {
      const result = await commandBus.execute(command);
      expect(result.status).toBe("accepted");
    }

    const updatedRecordRows = await db
      .prepare(
        `SELECT record_revision, last_event_id
         FROM records
         WHERE workspace_id = ? AND table_id = ? AND id = ? AND archived_at IS NULL`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{ last_event_id: string | null; record_revision: number }>();
    expect(updatedRecordRows.results).toEqual([
      {
        last_event_id: "evt_domain_6",
        record_revision: 2
      }
    ]);

    const updatedProjectionRows = await db
      .prepare(
        `SELECT projection_json, projection_version
         FROM record_projection
         WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{ projection_json: string; projection_version: number }>();
    expect(updatedProjectionRows.results).toEqual([
      {
        projection_json: JSON.stringify(
          {
            fields: {
              title: "Updated case"
            }
          },
          null,
          2
        ),
        projection_version: 3
      }
    ]);

    const archiveResult = await commandBus.execute(createDomainCommand("record.archive"));
    expect(archiveResult.status).toBe("accepted");

    const archivedRecordRows = await db
      .prepare(
        `SELECT record_revision, archived_at, updated_at, last_event_id
         FROM records
         WHERE workspace_id = ? AND table_id = ? AND id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{
        archived_at: string | null;
        last_event_id: string | null;
        record_revision: number;
        updated_at: string;
      }>();
    expect(archivedRecordRows.results).toEqual([
      {
        archived_at: "2026-06-06T00:01:06.000Z",
        last_event_id: "evt_domain_7",
        record_revision: 3,
        updated_at: "2026-06-06T00:01:06.000Z"
      }
    ]);

    const cellRows = await db
      .prepare(
        `SELECT field_id
         FROM cell_current
         WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{ field_id: string }>();
    expect(cellRows.results).toEqual([]);

    const projectionRows = await db
      .prepare(
        `SELECT projection_json
         FROM record_projection
         WHERE workspace_id = ? AND table_id = ? AND record_id = ?`
      )
      .bind("ws_1", "tbl_tickets", "rec_1")
      .all<{ projection_json: string }>();
    expect(projectionRows.results).toEqual([]);
  });

  it("commits event, receipt, outbox, and projection rows in one repository path", async () => {
    const db = createDatabase();
    seedTableForRecordCommits(db);
    const repository = createCloudTableD1Repository(db as unknown as D1Database);

    const result = await repository.commitAcceptedCommand({
      scopeKey: "ws_1:table:tbl_1",
      command: createRecordCreateCommand(),
      event: {
        commandId: "cmd_1",
        commandType: "record.create",
        createdAt: "2026-06-06T00:00:00.000Z",
        eventId: "evt_1",
        eventType: "record.created",
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
    seedTableForRecordCommits(db);
    const repository = createCloudTableD1Repository(db as unknown as D1Database);

    const first = await repository.commitAcceptedCommand({
      scopeKey: "ws_1:table:tbl_1",
      command: createRecordCreateCommand(),
      event: {
        commandId: "cmd_1",
        commandType: "record.create",
        createdAt: "2026-06-06T00:00:00.000Z",
        eventId: "evt_1",
        eventType: "record.created",
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
      command: createRecordCreateCommand({
        commandId: "cmd_2",
        idempotencyKey: "idem_2",
        payload: {
          recordId: "rec_2"
        }
      }),
      event: {
        commandId: "cmd_2",
        commandType: "record.create",
        createdAt: "2026-06-06T00:00:01.000Z",
        eventId: "evt_2",
        eventType: "record.created",
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
    seedTableForRecordCommits(db);
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

    const command = createRecordCreateCommand();

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

  it("persists workflow definitions, operator refs, and publish-state transitions", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: (() => {
        let counter = 0;
        return () => `evt_workflow_${++counter}`;
      })(),
      now: (() => {
        let counter = 0;
        return () => `2026-06-06T00:10:0${counter++}.000Z`;
      })(),
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(createDomainCommand("field.create"));

    const created = await commandBus.execute(createDomainCommand("workflow.create"));
    const published = await commandBus.execute(createDomainCommand("workflow.publish"));
    const paused = await commandBus.execute(createDomainCommand("workflow.pause"));

    expect(created.status).toBe("accepted");
    expect(published.status).toBe("accepted");
    expect(paused.status).toBe("accepted");

    const workflowRows = await db
      .prepare(
        `SELECT workflow_key, name, current_version, last_event_id
         FROM workflows
         WHERE workspace_id = ? AND id = ?`
      )
      .bind("ws_1", "wf_ticket_escalation")
      .all<{
        current_version: number;
        last_event_id: string | null;
        name: string;
        workflow_key: string;
      }>();
    expect(workflowRows.results).toEqual([
      {
        current_version: 1,
        last_event_id: "evt_workflow_6",
        name: "Ticket Escalation",
        workflow_key: "ticket-escalation"
      }
    ]);

    const versionRow = await db
      .prepare(
        `SELECT definition_json, published_at, last_event_id
         FROM workflow_versions
         WHERE workspace_id = ? AND workflow_id = ? AND version = 1`
      )
      .bind("ws_1", "wf_ticket_escalation")
      .first<{
        definition_json: string;
        last_event_id: string | null;
        published_at: string | null;
      }>();
    const definition = JSON.parse(versionRow?.definition_json ?? "{}") as {
      metadata?: {
        status?: string;
      };
    };
    expect(definition.metadata?.status).toBe("paused");
    expect(versionRow?.published_at).toBe("2026-06-06T00:10:04.000Z");
    expect(versionRow?.last_event_id).toBe("evt_workflow_6");

    const operatorRefs = await db
      .prepare(
        `SELECT operator_slot_key, operator_id, operator_version
         FROM workflow_operator_refs
         WHERE workspace_id = ? AND workflow_version_id = ?
         ORDER BY operator_slot_key ASC`
      )
      .bind("ws_1", "wf_ticket_escalation:v1")
      .all<{
        operator_id: string;
        operator_slot_key: string;
        operator_version: number;
      }>();
    expect(operatorRefs.results).toEqual([
      {
        operator_id: "set_cell",
        operator_slot_key: "action:0",
        operator_version: 1
      },
      {
        operator_id: "record_updated",
        operator_slot_key: "trigger",
        operator_version: 1
      }
    ]);
  });

  it("publishes workflows whose actions use the supported webhook command surface", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    const eventLedger = createEventLedger(db as unknown as D1Database, fieldTypeRegistry);
    let counter = 0;
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      idFactory: () => `evt_workflow_fail_${++counter}`,
      now: () => "2026-06-06T00:20:00.000Z",
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(createDomainCommand("field.create"));
    await commandBus.execute(
      createDomainCommand("workflow.create", {
        payload: {
          definition: {
            conditions: [],
            actions: [
              {
                input: {},
                operatorId: "send_webhook"
              }
            ],
            principal: {
              policyRevision: 7,
              principalId: "wf_service",
              schemaEpoch: 1,
              scopeHash: "scope:wf:tickets"
            },
            trigger: {
              match: {
                tableId: "tbl_tickets"
              },
              operatorId: "record_updated"
            },
            workflowId: "wf_ticket_escalation"
          }
        }
      })
    );

    const publish = await commandBus.execute(createDomainCommand("workflow.publish"));
    expect(publish.status).toBe("accepted");
    expect(publish.diagnostics).toEqual([]);

    const versionRow = await db
      .prepare(
        `SELECT definition_json, published_at
         FROM workflow_versions
         WHERE workspace_id = ? AND workflow_id = ? AND version = 1`
      )
      .bind("ws_1", "wf_ticket_escalation")
      .first<{ definition_json: string; published_at: string | null }>();
    expect(versionRow?.published_at).toBe("2026-06-06T00:20:00.000Z");
    expect(JSON.parse(versionRow?.definition_json ?? "{}")).toMatchObject({
      metadata: {
        status: "published"
      }
    });

    const operatorRefs = await db
      .prepare(
        `SELECT operator_slot_key, operator_id, operator_version
         FROM workflow_operator_refs
         WHERE workspace_id = ? AND workflow_version_id = ?
         ORDER BY operator_slot_key ASC`
      )
      .bind("ws_1", "wf_ticket_escalation:v1")
      .all<{
        operator_id: string;
        operator_slot_key: string;
        operator_version: number;
      }>();
    expect(operatorRefs.results).toEqual([
      {
        operator_id: "send_webhook",
        operator_slot_key: "action:0",
        operator_version: 1
      },
      {
        operator_id: "record_updated",
        operator_slot_key: "trigger",
        operator_version: 1
      }
    ]);
  });

  it("rejects invalid table and field references without committing domain state", async () => {
    const db = createDatabase();
    const fieldTypeRegistry = createFieldTypeRegistry();
    let eventCounter = 0;
    const commandBus = createCommandBus({
      eventLedger: createEventLedger(db as unknown as D1Database, fieldTypeRegistry),
      fieldTypeRegistry,
      idFactory: () => `evt_fail_${++eventCounter}`,
      now: () => "2026-06-06T00:00:00.000Z",
      permissionEngine: createPermissionEngineStub(),
      workflowOperatorRegistry: createWorkflowOperatorRegistry()
    });

    const missingTable = await commandBus.execute(createDomainCommand("field.create"));
    expect(missingTable.status).toBe("rejected");
    expect(missingTable.diagnostics).toEqual(["table_not_found:tbl_tickets"]);

    await commandBus.execute(createDomainCommand("base.create"));
    await commandBus.execute(createDomainCommand("table.create"));
    await commandBus.execute(createDomainCommand("record.create"));

    const missingField = await commandBus.execute(createDomainCommand("cell.set"));
    expect(missingField.status).toBe("rejected");
    expect(missingField.diagnostics).toEqual(["field_not_found:fld_title"]);

    const eventRows = await db
      .prepare(`SELECT event_id FROM event_ledger ORDER BY workspace_sequence ASC`)
      .bind()
      .all<{ event_id: string }>();
    expect(eventRows.results).toEqual([
      { event_id: "evt_fail_2" },
      { event_id: "evt_fail_3" },
      { event_id: "evt_fail_4" }
    ]);
  });
});
