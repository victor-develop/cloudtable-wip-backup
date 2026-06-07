import { describe, expect, it } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { WorkspaceInspection } from "../../../../src/core/agent-tools/types";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { createWorkspaceInspector } from "../../../../src/runtime/workspace-inspector";
import {
  SqliteD1Database,
  seedAppAndTable,
  seedWorkspace
} from "../../harness/runtime/sqlite-d1";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:app:crm",
  fields: {
    title: {
      agent: true,
      fieldId: "title",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    },
    customer_note: {
      agent: false,
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "visible",
      workflow: true,
      write: true
    },
    status: {
      agent: true,
      fieldId: "status",
      fieldType: "status.semantic",
      read: "visible",
      workflow: true,
      write: true
    }
  }
};

const fields = [
  {
    fieldId: "title",
    fieldType: "text.single_line"
  },
  {
    fieldId: "customer_note",
    fieldType: "text.long"
  },
  {
    fieldId: "status",
    fieldType: "status.semantic"
  }
] as const;

function createRegistry(overrides?: {
  dryRunResult?: CommandResult;
  executeResult?: CommandResult;
  inspectedWorkspace?: WorkspaceInspection;
}) {
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot
  });
  const commandBus: CommandBus = {
    async dryRun(command) {
      return (
        overrides?.dryRunResult ?? {
          accepted: true,
          diagnostics: ["dry_run"],
          events: [],
          permission: {
            allowed: true,
            reasons: []
          },
          replayProjection: {
            acceptedCommandIds: [],
            lastLogicalTime: "2026-06-07T00:00:00.000Z",
            receiptCount: 0,
            receipts: []
          },
          sideEffects: [],
          status: "accepted"
        }
      );
    },
    async execute(command) {
      return (
        overrides?.executeResult ?? {
          accepted: true,
          diagnostics: [],
          events: [
            {
              aggregateId: "status",
              aggregateType: "field",
              commandId: command.commandId,
              commandType: command.commandType,
              eventId: "evt_001",
              eventType: "field.created",
              tableId: command.tableId ?? null,
              workspaceId: command.workspaceId
            }
          ],
          permission: {
            allowed: true,
            reasons: []
          },
          replayProjection: {
            acceptedCommandIds: [command.commandId],
            lastLogicalTime: "2026-06-07T00:00:00.000Z",
            receiptCount: 1,
            receipts: []
          },
          sideEffects: [],
          status: "accepted"
        }
      );
    },
    normalizeFieldValue() {
      throw new Error("not used in agent tool registry tests");
    }
  };
  const inspectedWorkspace =
    overrides?.inspectedWorkspace ??
    ({
      apps: [
        {
          appId: "app_crm",
          name: "CRM",
          tableIds: ["tbl_accounts"]
        }
      ],
      catalog: {
        fieldTypes: ["text.single_line", "status.semantic"],
        workflowOperators: [
          {
            id: "record_updated",
            kind: "trigger",
            requiredCapabilities: ["workflows.execute"]
          }
        ]
      },
      tables: [
        {
          tableId: "tbl_accounts",
          name: "Accounts",
          fieldIds: ["title", "status"],
          viewIds: ["view_open"]
        }
      ],
      views: [
        {
          viewId: "view_open",
          tableId: "tbl_accounts",
          name: "Open Accounts"
        }
      ],
      workflows: [],
      workspaceId: "ws_demo"
    } satisfies WorkspaceInspection);

  return createAgentToolRegistry({
    commandBus,
    permissionEngine,
    viewPlanner: createViewPlanner(fieldTypeRegistry, permissionEngine),
    workflowOperatorRegistry,
    workspaceInspector: {
      inspect() {
        return inspectedWorkspace;
      }
    }
  });
}

function baseCommandInput(): Omit<CommandEnvelope, "commandType" | "payload" | "scope"> {
  return {
    actor: {
      mode: "agent",
      principalId: "usr_alice"
    },
    commandId: "cmd_001",
    idempotencyKey: "idem_001",
    permissionScopeHash: snapshot.scopeHash,
    permissionsVersion: snapshot.policyRevision,
    schemaEpoch: snapshot.schemaEpoch,
    workspaceId: snapshot.workspaceId
  };
}

function insertField(
  db: SqliteD1Database,
  input: {
    createdAt?: string;
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
      "{}",
      input.createdAt ?? "2026-06-06T00:00:00.000Z",
      input.createdAt ?? "2026-06-06T00:00:00.000Z",
      null,
      null
    );
}

function insertView(
  db: SqliteD1Database,
  input: {
    createdAt?: string;
    tableId: string;
    viewId: string;
    viewKey: string;
    viewName: string;
    workspaceId?: string;
  }
): void {
  const createdAt = input.createdAt ?? "2026-06-06T00:00:00.000Z";
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
      input.workspaceId ?? "ws_1",
      input.tableId,
      input.viewKey,
      input.viewName,
      1,
      createdAt,
      createdAt,
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
      input.workspaceId ?? "ws_1",
      input.viewId,
      1,
      JSON.stringify({
        filterFieldIds: [],
        groupByFieldId: null,
        sortFieldIds: [],
        visibleFieldIds: []
      }),
      createdAt,
      "usr_alice",
      null
    );
}

function insertWorkflow(
  db: SqliteD1Database,
  input: {
    createdAt?: string;
    definition?: Record<string, unknown>;
    name: string;
    publishedAt?: string | null;
    workflowId: string;
    workflowKey: string;
    workspaceId?: string;
  }
): void {
  const createdAt = input.createdAt ?? "2026-06-06T00:00:00.000Z";
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
      createdAt,
      createdAt,
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
              tableId: "tbl_accounts"
            }
          }
        }
      ),
      input.publishedAt ?? null,
      null
    );
}

describe("cloudtable agent tool registry", () => {
  it("publishes the v1 app-building surface with explicit bindings", () => {
    const registry = createRegistry();

    expect(registry.list().map((tool) => tool.id)).toEqual([
      "inspectWorkspace",
      "createTable",
      "createField",
      "createView",
      "updateView",
      "configureFieldPermission",
      "proposeWorkflow",
      "dryRunCommand",
      "executeCommand"
    ]);
    expect(registry.require("createTable")).toMatchObject({
      binding: {
        commandType: "table.create",
        kind: "command-builder",
        scope: "workspace"
      },
      successorToolId: "dryRunCommand"
    });
    expect(registry.require("dryRunCommand")).toMatchObject({
      binding: {
        kind: "command-bus",
        operation: "dry-run"
      },
      successorToolId: "executeCommand"
    });
  });

  it("inspects workspace state and catalog through the query service binding", async () => {
    const registry = createRegistry();

    const result = await registry.invoke({
      toolId: "inspectWorkspace",
      input: {
        include: ["apps", "tables", "catalog"],
        workspaceId: "ws_demo"
      }
    });

    expect(result).toEqual({
      kind: "workspace-inspection",
      workspace: {
        apps: [
          {
            appId: "app_crm",
            name: "CRM",
            tableIds: ["tbl_accounts"]
          }
        ],
        catalog: {
          fieldTypes: ["text.single_line", "status.semantic"],
          workflowOperators: [
            {
              id: "record_updated",
              kind: "trigger",
              requiredCapabilities: ["workflows.execute"]
            }
          ]
        },
        tables: [
          {
            tableId: "tbl_accounts",
            name: "Accounts",
            fieldIds: ["title", "status"],
            viewIds: ["view_open"]
          }
        ],
        views: [
          {
            viewId: "view_open",
            tableId: "tbl_accounts",
            name: "Open Accounts"
          }
        ],
        workflows: [],
        workspaceId: "ws_demo"
      }
    });
  });

  it("loads real workspace metadata through the shared D1-backed inspector", async () => {
    const db = new SqliteD1Database();
    seedWorkspace(db, "ws_1");
    seedAppAndTable(db, {
      appId: "app_crm",
      tableId: "tbl_accounts",
      workspaceId: "ws_1"
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
        "tbl_contacts",
        "ws_1",
        "app_crm",
        "contacts",
        "Contacts",
        0,
        1,
        "2026-06-06T00:00:02.000Z",
        "2026-06-06T00:00:02.000Z",
        null,
        null
      );
    insertField(db, {
      createdAt: "2026-06-06T00:00:03.000Z",
      fieldId: "fld_name",
      fieldKey: "name",
      fieldType: "text.single_line",
      label: "Name",
      tableId: "tbl_accounts"
    });
    insertField(db, {
      createdAt: "2026-06-06T00:00:04.000Z",
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status.semantic",
      label: "Status",
      tableId: "tbl_accounts"
    });
    insertView(db, {
      createdAt: "2026-06-06T00:00:05.000Z",
      tableId: "tbl_accounts",
      viewId: "view_open",
      viewKey: "open",
      viewName: "Open Accounts"
    });
    insertWorkflow(db, {
      createdAt: "2026-06-06T00:00:06.000Z",
      definition: {
        metadata: {
          status: "paused"
        },
        trigger: {
          match: {
            tableId: "tbl_accounts"
          }
        }
      },
      name: "Follow Up Pause",
      publishedAt: "2026-06-06T00:00:06.000Z",
      workflowId: "wf_follow_up",
      workflowKey: "follow-up"
    });

    const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
      snapshot
    });
    const commandBus: CommandBus = {
      async dryRun() {
        throw new Error("not used in D1 inspector test");
      },
      async execute() {
        throw new Error("not used in D1 inspector test");
      },
      normalizeFieldValue() {
        throw new Error("not used in D1 inspector test");
      }
    };

    const registry = createAgentToolRegistry({
      commandBus,
      permissionEngine,
      viewPlanner: createViewPlanner(fieldTypeRegistry, permissionEngine),
      workflowOperatorRegistry,
      workspaceInspector: createWorkspaceInspector(
        db as unknown as D1Database,
        fieldTypeRegistry,
        workflowOperatorRegistry
      )
    });

    const result = await registry.invoke({
      toolId: "inspectWorkspace",
      input: {
        workspaceId: "ws_1"
      }
    });

    expect(result).toEqual({
      kind: "workspace-inspection",
      workspace: {
        apps: [
          {
            appId: "app_crm",
            name: "App 1",
            tableIds: ["tbl_accounts", "tbl_contacts"]
          }
        ],
        catalog: {
          fieldTypes: expect.arrayContaining(["text.single_line", "status.semantic"]),
          workflowOperators: expect.arrayContaining([
            expect.objectContaining({
              id: "set_cell"
            })
          ])
        },
        tables: [
          {
            fieldIds: ["fld_name", "fld_status"],
            name: "Table 1",
            tableId: "tbl_accounts",
            viewIds: ["view_open"]
          },
          {
            fieldIds: [],
            name: "Contacts",
            tableId: "tbl_contacts",
            viewIds: []
          }
        ],
        views: [
          {
            name: "Open Accounts",
            tableId: "tbl_accounts",
            viewId: "view_open"
          }
        ],
        workflows: [
          {
            name: "Follow Up Pause",
            status: "paused",
            tableId: "tbl_accounts",
            workflowId: "wf_follow_up"
          }
        ],
        workspaceId: "ws_1"
      }
    });
  });

  it("builds auditable command drafts for schema and permission mutations", async () => {
    const registry = createRegistry();

    const tableDraft = await registry.invoke({
      toolId: "createTable",
      input: {
        ...baseCommandInput(),
        appId: "app_crm",
        primaryField: {
          fieldId: "name",
          fieldType: "text.single_line",
          name: "Name",
          required: true
        },
        tableId: "tbl_accounts",
        tableName: "Accounts"
      }
    });
    const fieldDraft = await registry.invoke({
      toolId: "createField",
      input: {
        ...baseCommandInput(),
        fieldId: "status",
        fieldType: "status.semantic",
        name: "Status",
        required: true,
        tableId: "tbl_accounts"
      }
    });
    const permissionDraft = await registry.invoke({
      toolId: "configureFieldPermission",
      input: {
        ...baseCommandInput(),
        agent: false,
        fieldId: "customer_note",
        principalId: "role_support",
        read: "hidden",
        tableId: "tbl_accounts",
        workflow: true,
        write: false
      }
    });
    const updateViewDraft = await registry.invoke({
      toolId: "updateView",
      input: {
        ...baseCommandInput(),
        filterFieldIds: ["status"],
        groupByFieldId: "status",
        sortFieldIds: ["status"],
        tableId: "tbl_accounts",
        viewId: "view_open",
        viewName: "Open Accounts Revised",
        visibleFieldIds: ["title", "status"]
      }
    });

    expect(tableDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "table.create",
        payload: {
          appId: "app_crm",
          tableId: "tbl_accounts",
          tableName: "Accounts"
        }
      }
    });
    expect(fieldDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "field.create",
        payload: {
          fieldId: "status",
          fieldType: "status.semantic",
          tableId: "tbl_accounts"
        }
      }
    });
    expect(permissionDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "field.permission.configure",
        payload: {
          fieldId: "customer_note",
          policy: {
            agent: false,
            read: "hidden",
            workflow: true,
            write: false
          },
          principalId: "role_support"
        }
      }
    });
    expect(updateViewDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "view.update",
        payload: {
          tableId: "tbl_accounts",
          viewId: "view_open",
          viewName: "Open Accounts Revised",
          visibleFieldIds: ["title", "status"]
        }
      }
    });
  });

  it("routes workflow proposals through the workflow registry", async () => {
    const registry = createRegistry();

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record", "send_webhook"],
        businessRule: "When status changes to Qualified, notify sales ops.",
        fieldIds: ["status"],
        name: "Qualify lead",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_qualify_lead"
      }
    });

    expect(result).toMatchObject({
      diagnostics: [],
      kind: "workflow-proposal",
      command: {
        commandType: "workflow.create",
        scope: "workflow"
      },
      proposal: {
        actions: [
          {
            commandType: "record.update",
            id: "update_record"
          },
          {
            commandType: "workflow.webhook.enqueue",
            id: "send_webhook"
          }
        ],
        trigger: {
          id: "field_changed",
          kind: "trigger"
        },
        workflowId: "wf_qualify_lead"
      }
    });
  });

  it("shares the command bus for dry-run and execution", async () => {
    const registry = createRegistry();
    const command: CommandEnvelope = {
      ...baseCommandInput(),
      commandType: "field.create",
      payload: {
        fieldId: "status",
        fieldType: "status.semantic",
        name: "Status",
        required: true,
        tableId: "tbl_accounts"
      },
      scope: "workspace",
      tableId: "tbl_accounts"
    };

    const preview = await registry.invoke({
      toolId: "dryRunCommand",
      input: {
        command
      }
    });
    const execution = await registry.invoke({
      toolId: "executeCommand",
      input: {
        command
      }
    });

    expect(preview).toMatchObject({
      command,
      kind: "command-dry-run",
      result: {
        diagnostics: ["dry_run"],
        status: "accepted"
      }
    });
    expect(execution).toMatchObject({
      command,
      kind: "command-execution",
      result: {
        events: [
          {
            commandId: "cmd_001",
            commandType: "field.create",
            eventId: "evt_001"
          }
        ],
        status: "accepted"
      }
    });
  });

  it("sanitizes hidden field references from v1 tool payloads", () => {
    const registry = createRegistry();

    const sanitizedInput = registry.sanitizeInput(
      "createView",
      {
        filterFieldIds: ["title", "customer_note"],
        visibleFieldIds: ["title", "customer_note", "status"]
      },
      fields,
      snapshot
    );
    const sanitizedOutput = registry.sanitizeOutput(
      "createView",
      {
        fields: {
          customer_note: "hidden",
          title: "Acme",
          status: "Open"
        },
        impactedFieldIds: ["title", "customer_note"]
      },
      fields,
      snapshot
    );

    expect(sanitizedInput).toEqual({
      diagnostics: ["agent_hidden:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        filterFieldIds: ["title"],
        visibleFieldIds: ["title", "status"]
      }
    });
    expect(sanitizedOutput).toEqual({
      diagnostics: ["agent_hidden:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        fields: {
          status: "Open",
          title: "Acme"
        },
        impactedFieldIds: ["title"]
      }
    });
  });

  it("shows an agent building a small app via table, field, view, permission, and workflow tools", async () => {
    const registry = createRegistry();

    const tableDraft = await registry.invoke({
      toolId: "createTable",
      input: {
        ...baseCommandInput(),
        appId: "app_crm",
        primaryField: {
          fieldId: "name",
          fieldType: "text.single_line",
          name: "Name"
        },
        tableId: "tbl_accounts",
        tableName: "Accounts"
      }
    });
    const fieldDraft = await registry.invoke({
      toolId: "createField",
      input: {
        ...baseCommandInput(),
        fieldId: "status",
        fieldType: "status.semantic",
        name: "Status",
        tableId: "tbl_accounts"
      }
    });
    const viewDraft = await registry.invoke({
      toolId: "createView",
      input: {
        ...baseCommandInput(),
        filterFieldIds: ["status"],
        groupByFieldId: "status",
        sortFieldIds: ["title"],
        tableId: "tbl_accounts",
        viewId: "view_open_accounts",
        viewName: "Open Accounts",
        visibleFieldIds: ["title", "status"]
      }
    });
    const permissionDraft = await registry.invoke({
      toolId: "configureFieldPermission",
      input: {
        ...baseCommandInput(),
        agent: false,
        fieldId: "customer_note",
        principalId: "role_support",
        read: "hidden",
        tableId: "tbl_accounts",
        workflow: true,
        write: false
      }
    });
    const workflowProposal = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "When status changes to Qualified, set follow-up state.",
        name: "Qualified follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_follow_up"
      }
    });

    expect([tableDraft, fieldDraft, viewDraft, permissionDraft].every((result) => result.kind === "command-draft")).toBe(
      true
    );
    expect(workflowProposal).toMatchObject({
      command: {
        commandType: "workflow.create",
        payload: {
          workflowId: "wf_follow_up"
        }
      },
      kind: "workflow-proposal",
      proposal: {
        workflowId: "wf_follow_up"
      }
    });
  });
});
