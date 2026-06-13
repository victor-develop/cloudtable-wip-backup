import { describe, expect, it } from "vitest";

import { serializeAgentToolManifest } from "../../../../src/core/agent-tools/manifest";
import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { WorkspaceInspection } from "../../../../src/core/agent-tools/types";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import type { CommandEnvelope, CommandResult } from "../../../../src/core/commands/types";
import { serializeFieldTypeManifest } from "../../../../src/core/field-types/manifest";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";
import { createViewPlanner } from "../../../../src/core/views/planner";
import { serializeWorkflowOperatorManifest } from "../../../../src/core/workflows/manifest";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { buildWorkflowAuthoringMetadata } from "../../../../src/core/workflows/binding-metadata";
import { createAppInspector } from "../../../../src/runtime/app-inspector";
import { createWorkspaceInspector } from "../../../../src/runtime/workspace-inspector";
import {
  SqliteD1Database,
  seedAppAndTable,
  seedWorkspace
} from "../../harness/runtime/sqlite-d1";
import {
  buildWorkflowBindingContract,
  createAssigneeAliasWorkflowBindingField,
  createDateWorkflowBindingField,
  createLongTextWorkflowBindingField,
  createNumberWorkflowBindingField,
  createRelationWorkflowBindingField,
  createRowOwnerWorkflowBindingField,
  createStatusWorkflowBindingField
} from "../../harness/workflow-binding-contract";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

function supportedConditionOperatorManifests(operatorIds: readonly string[]) {
  return operatorIds.map((operatorId) =>
    serializeWorkflowOperatorManifest(workflowOperatorRegistry.require(operatorId))
  );
}

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
  appInspectionResult?: Record<string, unknown> | null;
  dryRunResult?: CommandResult;
  executeResult?: CommandResult;
  inspectedWorkspace?: WorkspaceInspection;
  tableSchemaInspectionResult?: Record<string, unknown> | null;
  viewDefinitionInspectionResult?: Record<string, unknown> | null;
  workflowDefinitionInspectionResult?: Record<string, unknown> | null;
  permissionPersonaPreviewResult?: Record<string, unknown> | null;
  activityHistoryResult?: Record<string, unknown>;
  recordInspectionResult?: Record<string, unknown> | null;
  viewQueryResult?: Record<string, unknown> | null;
  workflowHistoryResult?: Record<string, unknown>;
  workflowRunResult?: Record<string, unknown> | null;
  workflowDeadLetterReplayResult?:
    | {
        deadLetterId: string;
        replayRequestId: string;
        status: "enqueued";
      }
    | {
        deadLetterId: string;
        message: string;
        reason: "already_requested" | "not_found" | "not_replayable";
        replayRequestId: string;
        status: "rejected";
      };
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
  let registry: ReturnType<typeof createAgentToolRegistry>;
  const inspectedWorkspace =
    overrides?.inspectedWorkspace ??
    ({
      apps: [
        {
          appId: "app_crm",
          name: "CRM",
          slug: "crm",
          tableIds: ["tbl_accounts"]
        }
      ],
      catalog: {
        agentTools: [],
        fieldTypes: [
          serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line")),
          serializeFieldTypeManifest(fieldTypeRegistry.require("status.semantic"))
        ],
        workflowOperators: [
          serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("record_updated"))
        ]
      },
      tables: [
        {
          tableId: "tbl_accounts",
          name: "Accounts",
          fieldIds: ["title", "status"],
          view: {
            fieldIds: [],
            fields: {},
            filterableFieldIds: [],
            groupableFieldIds: [],
            sortableFieldIds: []
          },
          workflow: { bindings: {} },
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

  registry = createAgentToolRegistry({
    commandBus,
    permissionEngine,
    viewPlanner: createViewPlanner(fieldTypeRegistry, permissionEngine),
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
          } as never;
        }

        if (!("tableId" in input)) {
          return {
            entries: [],
            page: {
              limit: input.limit ?? 25,
              nextBeforeWorkspaceSequence: null
            },
            workspaceId: input.workspaceId
          } as never;
        }

        return (overrides?.activityHistoryResult ??
          {
            entries: [],
            page: {
              limit: 25,
              nextBeforeTableSequence: null
            },
            tableId: "tbl_accounts",
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    appInspector: {
      inspect() {
        return (overrides?.appInspectionResult ??
          {
            appId: "app_crm",
            createdAt: "2026-06-06T00:00:00.000Z",
            name: "CRM",
            slug: "crm",
            tableCount: 1,
            tableIds: ["tbl_accounts"],
            updatedAt: "2026-06-06T00:00:00.000Z",
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    tableSchemaInspector: {
      read() {
        return (overrides?.tableSchemaInspectionResult ??
          {
            appId: "app_crm",
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
            schemaEpoch: 3,
            tableId: "tbl_accounts",
            tableName: "Accounts",
            tableSchemaVersion: 2,
            tableSlug: "accounts",
            workflow: { bindings: {} },
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    viewDefinitionInspector: {
      read() {
        return (overrides?.viewDefinitionInspectionResult ??
          {
            definition: {
              filterFieldIds: ["status"],
              filters: [
                {
                  fieldId: "status",
                  operatorId: "equals",
                  protected: false,
                  value: "open"
                }
              ],
              groupByFieldId: null,
              showEmptyGroups: false,
              sortFieldIds: ["title"],
              sorts: [
                {
                  fieldId: "title",
                  mode: "ascending"
                }
              ],
              visibleFieldIds: ["title", "status"]
            },
            tableId: "tbl_accounts",
            viewId: "view_open",
            viewKey: "open",
            viewName: "Open Accounts",
            viewSchemaVersion: 2,
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    workflowDefinitionInspector: {
      read() {
        return (overrides?.workflowDefinitionInspectionResult ??
          {
            currentVersion: 2,
            definition: {
              actions: [
                {
                  input: {
                    fieldId: "status",
                    tableId: "tbl_accounts",
                    value: "open"
                  },
                  operatorId: "record.patch"
                }
              ],
              conditions: [],
              metadata: {
                status: "paused"
              },
              trigger: {
                match: {
                  tableId: "tbl_accounts"
                },
                operatorId: "manual"
              },
              workflowId: "wf_demo"
            },
            effectiveVersion: 2,
            publishedAt: "2026-06-06T00:00:00.000Z",
            status: "paused",
            triggerTableId: "tbl_accounts",
            workflow: { bindings: {} },
            workflowId: "wf_demo",
            workflowKey: "demo",
            workflowName: "Demo Workflow",
            workflowVersionId: "wf_demo:v2",
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    permissionPersonaPreviewReader: {
      read() {
        return (overrides?.permissionPersonaPreviewResult ??
          {
            actions: {
              allowedMutatingToolIds: ["updateRecord"],
              allowedToolIds: ["queryView", "updateRecord"],
              blockedMutatingToolIds: [],
              blockedToolIds: [],
              tools: []
            },
            fields: [
              {
                configuredVisible: true,
                fieldId: "title",
                fieldKey: "title",
                fieldType: "text.single_line",
                hiddenByView: false,
                label: "Title",
                referencedByFilter: false,
                referencedByGroup: false,
                referencedBySort: true,
                surfaces: {
                  agentTool: {
                    allowed: true,
                    fieldId: "title",
                    fieldType: "text.single_line",
                    readState: "visible",
                    reasons: [],
                    writeAllowed: true
                  },
                  commandIngress: {
                    allowed: true,
                    fieldId: "title",
                    fieldType: "text.single_line",
                    readState: "visible",
                    reasons: [],
                    writeAllowed: true
                  },
                  viewQuery: {
                    allowed: true,
                    fieldId: "title",
                    fieldType: "text.single_line",
                    readState: "visible",
                    reasons: [],
                    writeAllowed: true
                  },
                  workflowStep: {
                    allowed: true,
                    fieldId: "title",
                    fieldType: "text.single_line",
                    readState: "visible",
                    reasons: [],
                    writeAllowed: true
                  }
                }
              }
            ],
            principalId: "usr_alice",
            rows: [],
            table: {
              appId: "app_crm",
              schemaEpoch: 3,
              tableId: "tbl_accounts",
              tableName: "Accounts",
              tableSchemaVersion: 2,
              tableSlug: "accounts"
            },
            view: {
              configuredVisibleFieldIds: ["title"],
              filters: [],
              groupByFieldId: null,
              sortFieldIds: ["title"],
              surfaces: {
                agentTool: {
                  hiddenFieldIds: [],
                  readOnlyFieldIds: [],
                  redactedFieldIds: [],
                  visibleFieldIds: ["title"],
                  writableFieldIds: ["title"]
                },
                commandIngress: {
                  hiddenFieldIds: [],
                  readOnlyFieldIds: [],
                  redactedFieldIds: [],
                  visibleFieldIds: ["title"],
                  writableFieldIds: ["title"]
                },
                viewQuery: {
                  hiddenFieldIds: [],
                  readOnlyFieldIds: [],
                  redactedFieldIds: [],
                  visibleFieldIds: ["title"],
                  writableFieldIds: ["title"]
                },
                workflowStep: {
                  hiddenFieldIds: [],
                  readOnlyFieldIds: [],
                  redactedFieldIds: [],
                  visibleFieldIds: ["title"],
                  writableFieldIds: ["title"]
                }
              },
              viewId: "view_open",
              viewKey: "open",
              viewName: "Open Accounts",
              viewQuery: {
                allowed: true,
                blockedFieldIds: [],
                diagnostics: [],
                tableId: "tbl_accounts",
                viewId: "view_open",
                viewKey: "open",
                viewName: "Open Accounts",
                visibleFieldIds: ["title"]
              },
              viewSchemaVersion: 2
            },
            workspaceId: "ws_demo"
          }) as never;
      }
    },
    recordInspector: {
      read() {
        return (overrides?.recordInspectionResult ??
          {
            projection: {
              fields: {
                title: "Acme"
              }
            },
            projectionVersion: 3,
            record: {
              id: "rec_demo",
              record_key: "record-demo"
            }
          }) as never;
      }
    },
    viewQueryReader: {
      read() {
        return (overrides?.viewQueryResult ??
          {
            fields: [
              {
                fieldId: "title",
                fieldKey: "title"
              }
            ],
            rows: [
              {
                cells: {
                  title: "Acme"
                },
                hiddenFieldIds: [],
                recordId: "rec_demo",
                recordKey: "record-demo",
                redactedFieldIds: [],
                states: {
                  title: "visible"
                }
              }
            ],
            view: {
              allowed: true,
              blockedFieldIds: [],
              diagnostics: [],
              tableId: "tbl_accounts",
              viewId: "view_open",
              viewKey: "open",
              viewName: "Open Accounts",
              visibleFieldIds: ["title"]
            }
          }) as never;
      }
    },
    workflowDeadLetterReplayRequester: {
      requestReplay(input) {
        return (
          overrides?.workflowDeadLetterReplayResult ?? {
            deadLetterId: input.deadLetterId,
            replayRequestId:
              input.replayRequestId ?? `dead-letter-replay:${input.deadLetterId}`,
            status: "enqueued"
          }
        ) as never;
      }
    },
    workflowHistoryReader: {
      read() {
        return (overrides?.workflowHistoryResult ??
          {
            runs: [],
            workflowId: "wf_demo"
          }) as never;
      }
    },
    workflowRunReader: {
      read() {
        return (overrides?.workflowRunResult ??
          {
            id: "wfr_demo",
            status: "completed",
            workflowId: "wf_demo"
          }) as never;
      }
    },
    workflowOperatorRegistry,
    workspaceInspector: {
      inspect() {
        return inspectedWorkspace;
      }
    }
  });

  if (!overrides?.inspectedWorkspace) {
    inspectedWorkspace.catalog!.agentTools = [
      serializeAgentToolManifest(registry.require("inspectWorkspace"))
    ];
  }

  return registry;
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
        showEmptyGroups: false,
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
      "inspectApp",
      "inspectTableSchema",
      "inspectViewDefinition",
      "inspectWorkflowDefinition",
      "explainPermissions",
      "previewPermissionPersona",
      "inspectRecord",
      "queryView",
      "readActivityHistory",
      "readWorkspaceActivityHistory",
      "readAppActivityHistory",
      "readWorkflowHistory",
      "readWorkflowRunDetail",
      "prepareWorkflowDeadLetterReplay",
      "requestWorkflowDeadLetterReplay",
      "createApp",
      "createTable",
      "createField",
      "createView",
      "updateView",
      "deleteView",
      "configureFieldPermission",
      "updateField",
      "archiveField",
      "reorderFields",
      "createRecord",
      "updateRecord",
      "bulkUpdateRecords",
      "archiveRecord",
      "updateCell",
      "proposeWorkflow",
      "updateWorkflow",
      "publishWorkflow",
      "pauseWorkflow",
      "runWorkflow",
      "dryRunCommand",
      "executeCommand"
    ]);
    expect(registry.require("inspectApp")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "appInspector"
      },
      scope: "app"
    });
    expect(registry.require("inspectTableSchema")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "tableSchemaInspector"
      },
      scope: "table"
    });
    expect(registry.require("inspectViewDefinition")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "viewDefinitionInspector"
      },
      scope: "view"
    });
    expect(registry.require("inspectWorkflowDefinition")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "workflowDefinitionInspector"
      },
      scope: "workflow"
    });
    expect(registry.require("createApp")).toMatchObject({
      binding: {
        commandType: "base.create",
        kind: "command-builder",
        scope: "workspace"
      },
      successorToolId: "dryRunCommand"
    });
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
    expect(registry.require("readWorkflowHistory")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "workflowHistoryReader"
      },
      scope: "workflow"
    });
    expect(registry.require("explainPermissions")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "permissionEngine"
      },
      scope: "table"
    });
    expect(registry.require("previewPermissionPersona")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "permissionPersonaPreviewReader"
      },
      phase: "preview",
      scope: "view"
    });
    expect(registry.require("inspectRecord")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "recordInspector"
      },
      scope: "table"
    });
    expect(registry.require("queryView")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "viewQueryReader"
      },
      scope: "view"
    });
    expect(registry.require("readActivityHistory")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "activityHistoryReader"
      },
      scope: "table"
    });
    expect(registry.require("readWorkspaceActivityHistory")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "activityHistoryReader"
      },
      scope: "app"
    });
    expect(registry.require("readAppActivityHistory")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "activityHistoryReader"
      },
      scope: "app"
    });
    expect(registry.require("readWorkflowRunDetail")).toMatchObject({
      binding: {
        kind: "query-service",
        service: "workflowRunReader"
      },
      scope: "workflow"
    });
    expect(registry.require("prepareWorkflowDeadLetterReplay")).toMatchObject({
      binding: {
        kind: "workflow-operation",
        operation: "replay-dead-letter"
      },
      phase: "preview",
      scope: "workflow",
      successorToolId: "requestWorkflowDeadLetterReplay"
    });
    expect(registry.require("requestWorkflowDeadLetterReplay")).toMatchObject({
      binding: {
        kind: "workflow-operation",
        operation: "replay-dead-letter"
      },
      phase: "execute",
      scope: "workflow"
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

    expect(result).toMatchObject({
      kind: "workspace-inspection",
      workspace: {
        apps: [
          {
            appId: "app_crm",
            name: "CRM",
            slug: "crm",
            tableIds: ["tbl_accounts"]
          }
        ],
        catalog: {
          agentTools: [
            serializeAgentToolManifest(registry.require("inspectWorkspace"))
          ],
          fieldTypes: [
            serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line")),
            serializeFieldTypeManifest(fieldTypeRegistry.require("status.semantic"))
          ],
          workflowOperators: [
            serializeWorkflowOperatorManifest(workflowOperatorRegistry.require("record_updated"))
          ]
        },
        tables: [
          {
            tableId: "tbl_accounts",
            name: "Accounts",
            fieldIds: ["title", "status"],
            view: {
              fieldIds: [],
              fields: {},
              filterableFieldIds: [],
              groupableFieldIds: [],
              sortableFieldIds: []
            },
            workflow: { bindings: {} },
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

  it("inspects direct app bootstrap metadata through the dedicated query service", async () => {
    const registry = createRegistry();

    const result = await registry.invoke({
      toolId: "inspectApp",
      input: {
        appId: "app_crm",
        workspaceId: "ws_demo"
      }
    });

    expect(result).toEqual({
      app: {
        appId: "app_crm",
        createdAt: "2026-06-06T00:00:00.000Z",
        name: "CRM",
        slug: "crm",
        tableCount: 1,
        tableIds: ["tbl_accounts"],
        updatedAt: "2026-06-06T00:00:00.000Z",
        workspaceId: "ws_demo"
      },
      kind: "app-inspection"
    });
  });

  it("inspects table, view, and workflow definitions through dedicated query services", async () => {
    const registry = createRegistry();

    const schemaResult = await registry.invoke({
      toolId: "inspectTableSchema",
      input: {
        tableId: "tbl_accounts",
        workspaceId: "ws_demo"
      }
    });
    const viewResult = await registry.invoke({
      toolId: "inspectViewDefinition",
      input: {
        tableId: "tbl_accounts",
        viewId: "view_open",
        workspaceId: "ws_demo"
      }
    });
    const workflowResult = await registry.invoke({
      toolId: "inspectWorkflowDefinition",
      input: {
        workflowId: "wf_demo",
        workspaceId: "ws_demo"
      }
    });

    expect(schemaResult).toEqual({
      kind: "table-schema-inspection",
      schema: {
        appId: "app_crm",
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
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: { bindings: {} },
        workspaceId: "ws_demo"
      }
    });
    expect(viewResult).toEqual({
      kind: "view-definition-inspection",
      view: {
        definition: {
          filterFieldIds: ["status"],
          filters: [
            {
              fieldId: "status",
              operatorId: "equals",
              protected: false,
              value: "open"
            }
          ],
          groupByFieldId: null,
          showEmptyGroups: false,
          sortFieldIds: ["title"],
          sorts: [
            {
              fieldId: "title",
              mode: "ascending"
            }
          ],
          visibleFieldIds: ["title", "status"]
        },
        tableId: "tbl_accounts",
        viewId: "view_open",
        viewKey: "open",
        viewName: "Open Accounts",
        viewSchemaVersion: 2,
        workspaceId: "ws_demo"
      }
    });
    expect(workflowResult).toEqual({
      kind: "workflow-definition-inspection",
      workflow: {
        currentVersion: 2,
        definition: {
          actions: [
            {
              input: {
                fieldId: "status",
                tableId: "tbl_accounts",
                value: "open"
              },
              operatorId: "record.patch"
            }
          ],
          conditions: [],
          metadata: {
            status: "paused"
          },
          trigger: {
            match: {
              tableId: "tbl_accounts"
            },
            operatorId: "manual"
          },
          workflowId: "wf_demo"
        },
        effectiveVersion: 2,
        publishedAt: "2026-06-06T00:00:00.000Z",
        status: "paused",
        triggerTableId: "tbl_accounts",
        workflow: { bindings: {} },
        workflowId: "wf_demo",
        workflowKey: "demo",
        workflowName: "Demo Workflow",
        workflowVersionId: "wf_demo:v2",
        workspaceId: "ws_demo"
      }
    });
  });

  it("routes workflow observability reads through dedicated workflow services", async () => {
    const registry = createRegistry({
      workflowHistoryResult: {
        runs: [
          {
            id: "wfr_demo_1",
            status: "dead_lettered"
          }
        ],
        workflowId: "wf_demo"
      },
      workflowRunResult: {
        id: "wfr_demo_1",
        status: "dead_lettered",
        workflowId: "wf_demo"
      }
    });

    const historyResult = await registry.invoke({
      toolId: "readWorkflowHistory",
      input: {
        workflowId: "wf_demo",
        workspaceId: "ws_demo"
      }
    });
    const runResult = await registry.invoke({
      toolId: "readWorkflowRunDetail",
      input: {
        workflowRunId: "wfr_demo_1",
        workspaceId: "ws_demo"
      }
    });

    expect(historyResult).toEqual({
      history: {
        runs: [
          {
            id: "wfr_demo_1",
            status: "dead_lettered"
          }
        ],
        workflowId: "wf_demo"
      },
      kind: "workflow-history"
    });
    expect(runResult).toEqual({
      kind: "workflow-run-detail",
      run: {
        id: "wfr_demo_1",
        status: "dead_lettered",
        workflowId: "wf_demo"
      }
    });
  });

  it("routes workflow dead-letter replay through the dedicated workflow operations service", async () => {
    const registry = createRegistry();

    const draft = await registry.invoke({
      toolId: "prepareWorkflowDeadLetterReplay",
      input: {
        actor: {
          mode: "agent",
          principalId: "usr_alice"
        },
        deadLetterId: "wdl:wfr_demo_1:step:0",
        permissionScopeHash: "scope:table:tbl_accounts",
        permissionsVersion: 7,
        schemaEpoch: 3,
        workspaceId: "ws_demo"
      }
    });
    const execution = await registry.invoke({
      toolId: "requestWorkflowDeadLetterReplay",
      input: {
        actor: {
          mode: "agent",
          principalId: "usr_alice"
        },
        deadLetterId: "wdl:wfr_demo_1:step:0",
        permissionScopeHash: "scope:table:tbl_accounts",
        permissionsVersion: 7,
        schemaEpoch: 3,
        workspaceId: "ws_demo"
      }
    });

    expect(draft).toEqual({
      diffs: [
        {
          action: "propose",
          after: {
            deadLetterId: "wdl:wfr_demo_1:step:0",
            replayRequestId: "dead-letter-replay:wdl:wfr_demo_1:step:0"
          },
          note: "Request replay for one eligible workflow dead letter.",
          path: "$.workflowDeadLetterReplay"
        }
      ],
      kind: "workflow-dead-letter-replay-draft",
      request: {
        deadLetterId: "wdl:wfr_demo_1:step:0",
        replayRequestId: "dead-letter-replay:wdl:wfr_demo_1:step:0",
        workspaceId: "ws_demo"
      }
    });
    expect(execution).toEqual({
      deadLetterId: "wdl:wfr_demo_1:step:0",
      kind: "workflow-dead-letter-replay",
      replayRequestId: "dead-letter-replay:wdl:wfr_demo_1:step:0",
      status: "enqueued"
    });
  });

  it("routes record, view, and activity inspection through dedicated read-only services", async () => {
    const registry = createRegistry({
      activityHistoryResult: {
        entries: [
          {
            eventId: "evt_2"
          }
        ],
        page: {
          limit: 10,
          nextBeforeTableSequence: 1
        },
        record: {
          id: "rec_demo"
        },
        workspaceId: "ws_demo"
      },
      recordInspectionResult: {
        projection: {
          fields: {
            title: "Acme"
          }
        },
        projectionVersion: 4,
        record: {
          id: "rec_demo"
        }
      },
      viewQueryResult: {
        rows: [
          {
            cells: {
              title: "Acme"
            }
          }
        ],
        view: {
          allowed: true,
          viewId: "view_open"
        }
      }
    });

    const recordResult = await registry.invoke({
      toolId: "inspectRecord",
      input: {
        recordId: "rec_demo",
        tableId: "tbl_accounts",
        workspaceId: "ws_demo"
      }
    });
    const viewResult = await registry.invoke({
      toolId: "queryView",
      input: {
        tableId: "tbl_accounts",
        viewId: "view_open",
        workspaceId: "ws_demo"
      }
    });
    const activityResult = await registry.invoke({
      toolId: "readActivityHistory",
      input: {
        limit: 10,
        recordId: "rec_demo",
        tableId: "tbl_accounts",
        workspaceId: "ws_demo"
      }
    });
    const workspaceActivityResult = await registry.invoke({
      toolId: "readWorkspaceActivityHistory",
      input: {
        limit: 10,
        workspaceId: "ws_demo"
      }
    });
    const appActivityResult = await registry.invoke({
      toolId: "readAppActivityHistory",
      input: {
        appId: "app_crm",
        limit: 10,
        workspaceId: "ws_demo"
      }
    });

    expect(recordResult).toEqual({
      kind: "record-inspection",
      record: {
        projection: {
          fields: {
            title: "Acme"
          }
        },
        projectionVersion: 4,
        record: {
          id: "rec_demo"
        }
      }
    });
    expect(viewResult).toEqual({
      kind: "view-query",
      view: {
        rows: [
          {
            cells: {
              title: "Acme"
            }
          }
        ],
        view: {
          allowed: true,
          viewId: "view_open"
        }
      }
    });
    expect(activityResult).toEqual({
      activity: {
        entries: [
          {
            eventId: "evt_2"
          }
        ],
        page: {
          limit: 10,
          nextBeforeTableSequence: 1
        },
        record: {
          id: "rec_demo"
        },
        workspaceId: "ws_demo"
      },
      kind: "activity-history"
    });
    expect(workspaceActivityResult).toEqual({
      activity: {
        entries: [],
        page: {
          limit: 10,
          nextBeforeWorkspaceSequence: null
        },
        workspaceId: "ws_demo"
      },
      kind: "activity-history"
    });
    expect(appActivityResult).toEqual({
      activity: {
        appId: "app_crm",
        entries: [],
        page: {
          limit: 10,
          nextBeforeWorkspaceSequence: null
        },
        workspaceId: "ws_demo"
      },
      kind: "activity-history"
    });
  });

  it("explains permission decisions through a dedicated read-only agent tool", async () => {
    const registry = createRegistry();

    const result = await registry.invoke({
      toolId: "explainPermissions",
      input: {
        fieldId: "customer_note",
        fieldType: "text.long",
        surfaces: ["direct-record-read", "agent-tool"],
        tableId: "tbl_accounts",
        viewId: "view_open",
        workspaceId: "ws_demo"
      }
    });

    expect(result).toEqual({
      explanation: {
        fieldId: "customer_note",
        fieldType: "text.long",
        scope: {
          recordId: null,
          tableId: "tbl_accounts",
          viewId: "view_open",
          workspaceId: "ws_demo"
        },
        surfaces: [
          {
            allowed: true,
            message: "Field is visible for direct record reads.",
            readState: "visible",
            reasonMessages: [],
            reasons: [],
            surface: "direct-record-read",
            writeAllowed: true
          },
          {
            allowed: false,
            message: "Field is hidden for agent tools.",
            readState: "hidden",
            reasonMessages: ["Field is hidden for agent tools."],
            reasons: ["agent_hidden:customer_note"],
            surface: "agent-tool",
            writeAllowed: false
          }
        ]
      },
      kind: "permission-explanation"
    });
  });

  it("previews effective persona access for a saved view through a dedicated preview tool", async () => {
    const registry = createRegistry();

    const result = await registry.invoke({
      toolId: "previewPermissionPersona",
      input: {
        tableId: "tbl_accounts",
        viewId: "view_open",
        workspaceId: "ws_demo"
      }
    });

    expect(result).toEqual({
      kind: "permission-persona-preview",
      preview: {
        actions: {
          allowedMutatingToolIds: ["updateRecord"],
          allowedToolIds: ["queryView", "updateRecord"],
          blockedMutatingToolIds: [],
          blockedToolIds: [],
          tools: []
        },
        fields: [
          {
            configuredVisible: true,
            fieldId: "title",
            fieldKey: "title",
            fieldType: "text.single_line",
            hiddenByView: false,
            label: "Title",
            referencedByFilter: false,
            referencedByGroup: false,
            referencedBySort: true,
            surfaces: {
              agentTool: {
                allowed: true,
                fieldId: "title",
                fieldType: "text.single_line",
                readState: "visible",
                reasons: [],
                writeAllowed: true
              },
              commandIngress: {
                allowed: true,
                fieldId: "title",
                fieldType: "text.single_line",
                readState: "visible",
                reasons: [],
                writeAllowed: true
              },
              viewQuery: {
                allowed: true,
                fieldId: "title",
                fieldType: "text.single_line",
                readState: "visible",
                reasons: [],
                writeAllowed: true
              },
              workflowStep: {
                allowed: true,
                fieldId: "title",
                fieldType: "text.single_line",
                readState: "visible",
                reasons: [],
                writeAllowed: true
              }
            }
          }
        ],
        principalId: "usr_alice",
        rows: [],
        table: {
          appId: "app_crm",
          schemaEpoch: 3,
          tableId: "tbl_accounts",
          tableName: "Accounts",
          tableSchemaVersion: 2,
          tableSlug: "accounts"
        },
        view: {
          configuredVisibleFieldIds: ["title"],
          filters: [],
          groupByFieldId: null,
          sortFieldIds: ["title"],
          surfaces: {
            agentTool: {
              hiddenFieldIds: [],
              readOnlyFieldIds: [],
              redactedFieldIds: [],
              visibleFieldIds: ["title"],
              writableFieldIds: ["title"]
            },
            commandIngress: {
              hiddenFieldIds: [],
              readOnlyFieldIds: [],
              redactedFieldIds: [],
              visibleFieldIds: ["title"],
              writableFieldIds: ["title"]
            },
            viewQuery: {
              hiddenFieldIds: [],
              readOnlyFieldIds: [],
              redactedFieldIds: [],
              visibleFieldIds: ["title"],
              writableFieldIds: ["title"]
            },
            workflowStep: {
              hiddenFieldIds: [],
              readOnlyFieldIds: [],
              redactedFieldIds: [],
              visibleFieldIds: ["title"],
              writableFieldIds: ["title"]
            }
          },
          viewId: "view_open",
          viewKey: "open",
          viewName: "Open Accounts",
          viewQuery: {
            allowed: true,
            blockedFieldIds: [],
            diagnostics: [],
            tableId: "tbl_accounts",
            viewId: "view_open",
            viewKey: "open",
            viewName: "Open Accounts",
            visibleFieldIds: ["title"]
          },
          viewSchemaVersion: 2
        },
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
    const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
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
      activityHistoryReader: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      appInspector: createAppInspector(db as unknown as D1Database),
      tableSchemaInspector: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      viewDefinitionInspector: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      workflowDefinitionInspector: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      permissionPersonaPreviewReader: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      commandBus,
      permissionEngine,
      recordInspector: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      viewPlanner,
      viewQueryReader: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      workflowHistoryReader: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      workflowRunReader: {
        read() {
          throw new Error("not used in D1 inspector test");
        }
      },
      workflowDeadLetterReplayRequester: {
        requestReplay() {
          throw new Error("not used in D1 inspector test");
        }
      },
      workflowOperatorRegistry,
      workspaceInspector: createWorkspaceInspector(
        db as unknown as D1Database,
        fieldTypeRegistry,
        viewPlanner,
        workflowOperatorRegistry,
        () => registry
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
          slug: "app-1",
          tableIds: ["tbl_accounts", "tbl_contacts"]
        }
        ],
        catalog: {
          agentTools: expect.arrayContaining([
            expect.objectContaining({
              binding: {
                kind: "command-bus",
                operation: "dry-run"
              },
              id: "dryRunCommand",
              successorToolId: "executeCommand"
            })
          ]),
          fieldTypes: expect.arrayContaining([
            serializeFieldTypeManifest(fieldTypeRegistry.require("text.single_line")),
            serializeFieldTypeManifest(fieldTypeRegistry.require("status.semantic"))
          ]),
          workflowOperators: expect.arrayContaining([
            expect.objectContaining({
              commandType: "cell.set",
              id: "set_cell"
            })
          ])
        },
        tables: [
          {
            fieldIds: ["fld_name", "fld_status"],
            name: "Table 1",
            tableId: "tbl_accounts",
            view: {
              fieldIds: ["fld_name", "fld_status"],
              fields: {
                fld_name: {
                  capabilities: {
                    supportsFiltering: true,
                    supportsGrouping: true,
                    supportsSorting: true
                  },
                  fieldId: "fld_name",
                  fieldKey: "name",
                  fieldType: "text.single_line",
                  supportedFilterOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
                  supportedFilterOperators: supportedConditionOperatorManifests([
                    "equals",
                    "not_equals",
                    "is_empty",
                    "is_not_empty"
                  ]),
                  supportedSortModes: ["ascending", "descending"]
                },
                fld_status: {
                  capabilities: {
                    supportsFiltering: true,
                    supportsGrouping: true,
                    supportsSorting: true
                  },
                  fieldId: "fld_status",
                  fieldKey: "status",
                  fieldType: "status.semantic",
                  supportedFilterOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
                  supportedFilterOperators: supportedConditionOperatorManifests([
                    "equals",
                    "not_equals",
                    "is_empty",
                    "is_not_empty"
                  ]),
                  supportedSortModes: ["ascending", "descending"]
                }
              },
              filterableFieldIds: ["fld_name", "fld_status"],
              groupableFieldIds: ["fld_name", "fld_status"],
              sortableFieldIds: ["fld_name", "fld_status"]
            },
            workflow: {
              bindings: {
                "row.fields.name": {
                  binding: "row.fields.name",
                  fieldId: "fld_name",
                  fieldKey: "name",
                  fieldType: "text.single_line",
                  proposalHints: [
                    {
                      operatorId: "is_empty",
                      matchPhrases: ["missing", "empty", "blank", "not set", "unset"],
                      matchFieldPhrases: ["without {field}", "{field} missing"]
                    },
                    {
                      operatorId: "is_not_empty",
                      matchPhrases: ["present", "populated", "filled", "has value", "is set", "set"]
                    }
                  ],
                  supportedOperatorIds: ["equals", "not_equals", "is_empty", "is_not_empty"],
                  supportedOperators: supportedConditionOperatorManifests([
                    "equals",
                    "not_equals",
                    "is_empty",
                    "is_not_empty"
                  ]),
                  template: {
                    fieldIdPath: "row.fields.name.fieldId",
                    fieldTypePath: "row.fields.name.fieldType",
                    valuePath: "row.fields.name.value"
                  }
                },
                "row.fields.status": {
                  binding: "row.fields.status",
                  fieldId: "fld_status",
                  fieldKey: "status",
                  fieldType: "status.semantic",
                  proposalHints: [
                    {
                      operatorId: "is_empty",
                      matchPhrases: ["missing", "empty", "blank", "not set", "unset"],
                      matchFieldPhrases: ["without {field}", "{field} missing"]
                    },
                    {
                      operatorId: "is_not_empty",
                      matchPhrases: ["present", "populated", "filled", "has value", "is set", "set"]
                    }
                  ],
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
              }
            },
            viewIds: ["view_open"]
          },
          {
            fieldIds: [],
            name: "Contacts",
            tableId: "tbl_contacts",
            view: {
              fieldIds: [],
              fields: {},
              filterableFieldIds: [],
              groupableFieldIds: [],
              sortableFieldIds: []
            },
            workflow: { bindings: {} },
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

  it("builds auditable command drafts for schema, permission, and record mutations", async () => {
    const registry = createRegistry();

    const appDraft = await registry.invoke({
      toolId: "createApp",
      input: {
        ...baseCommandInput(),
        appId: "app_crm",
        appName: "CRM",
        appSlug: "crm"
      }
    });
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
    const updateFieldDraft = await registry.invoke({
      toolId: "updateField",
      input: {
        ...baseCommandInput(),
        config: {
          display: "currency",
          integerOnly: true
        },
        fieldId: "status",
        tableId: "tbl_accounts"
      }
    });
    const archiveFieldDraft = await registry.invoke({
      toolId: "archiveField",
      input: {
        ...baseCommandInput(),
        fieldId: "status",
        tableId: "tbl_accounts"
      }
    });
    const reorderFieldsDraft = await registry.invoke({
      toolId: "reorderFields",
      input: {
        ...baseCommandInput(),
        fieldIds: ["eta", "title", "status"],
        tableId: "tbl_accounts"
      }
    });
    const createRecordDraft = await registry.invoke({
      toolId: "createRecord",
      input: {
        ...baseCommandInput(),
        cells: {
          status: "Open",
          title: "Acme"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      }
    });
    const updateCellDraft = await registry.invoke({
      toolId: "updateCell",
      input: {
        ...baseCommandInput(),
        fieldId: "status",
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts",
        value: "Qualified"
      }
    });
    const updateRecordDraft = await registry.invoke({
      toolId: "updateRecord",
      input: {
        ...baseCommandInput(),
        patch: {
          status: "Qualified",
          title: "Acme Revised"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      }
    });
    const bulkUpdateRecordsDraft = await registry.invoke({
      toolId: "bulkUpdateRecords",
      input: {
        ...baseCommandInput(),
        tableId: "tbl_accounts",
        updates: [
          {
            patch: {
              status: "Qualified"
            },
            recordId: "rec_accounts_001"
          },
          {
            patch: {
              title: "Globex"
            },
            recordId: "rec_accounts_002"
          }
        ]
      }
    });
    const archiveRecordDraft = await registry.invoke({
      toolId: "archiveRecord",
      input: {
        ...baseCommandInput(),
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      }
    });
    const deleteViewDraft = await registry.invoke({
      toolId: "deleteView",
      input: {
        ...baseCommandInput(),
        tableId: "tbl_accounts",
        viewId: "view_open"
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

    expect(appDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "base.create",
        payload: {
          baseId: "app_crm",
          name: "CRM",
          slug: "crm"
        }
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
    expect(updateFieldDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "field.update",
        payload: {
          config: {
            display: "currency",
            integerOnly: true
          },
          fieldId: "status",
          tableId: "tbl_accounts"
        },
        scope: "workspace",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/fields/status"
        }
      ]
    });
    expect(archiveFieldDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "field.archive",
        payload: {
          fieldId: "status",
          tableId: "tbl_accounts"
        },
        scope: "workspace",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/fields/status"
        }
      ]
    });
    expect(reorderFieldsDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "field.reorder",
        payload: {
          fieldIds: ["eta", "title", "status"],
          tableId: "tbl_accounts"
        },
        scope: "workspace",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/fields"
        }
      ]
    });
    expect(createRecordDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "record.create",
        payload: {
          cells: {
            status: "Open",
            title: "Acme"
          },
          recordId: "rec_accounts_001"
        },
        scope: "table",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "create",
          path: "/tables/tbl_accounts/records/rec_accounts_001"
        }
      ]
    });
    expect(updateRecordDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "record.update",
        payload: {
          patch: {
            status: "Qualified",
            title: "Acme Revised"
          },
          recordId: "rec_accounts_001"
        },
        scope: "table",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/records/rec_accounts_001"
        }
      ]
    });
    expect(bulkUpdateRecordsDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "records.bulk_patch",
        payload: {
          updates: [
            {
              patch: {
                status: "Qualified"
              },
              recordId: "rec_accounts_001"
            },
            {
              patch: {
                title: "Globex"
              },
              recordId: "rec_accounts_002"
            }
          ]
        },
        scope: "table",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/records/rec_accounts_001"
        },
        {
          action: "update",
          path: "/tables/tbl_accounts/records/rec_accounts_002"
        }
      ]
    });
    expect(archiveRecordDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "record.archive",
        payload: {
          recordId: "rec_accounts_001"
        },
        scope: "table",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/records/rec_accounts_001"
        }
      ]
    });
    expect(deleteViewDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "view.delete",
        payload: {
          tableId: "tbl_accounts",
          viewId: "view_open"
        },
        scope: "workspace",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "delete",
          path: "/tables/tbl_accounts/views/view_open"
        }
      ]
    });
    expect(updateCellDraft).toMatchObject({
      kind: "command-draft",
      command: {
        commandType: "cell.set",
        payload: {
          fieldId: "status",
          recordId: "rec_accounts_001",
          value: "Qualified"
        },
        scope: "table",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/tables/tbl_accounts/records/rec_accounts_001/fields/status"
        }
      ]
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
        payload: {
          definition: {
            trigger: {
              match: {
                fieldIds: ["status"],
                tableId: "tbl_accounts"
              },
              operatorId: "field_changed"
            }
          }
        },
        scope: "workflow"
      },
      proposal: {
        actions: [
          {
            commandType: "record.update",
            fixtureContract: [{ id: "update_record.action.sample", kind: "action" }],
            id: "update_record",
            proposalTemplate: {
              patch: {
                title: "Bravo"
              },
              recordId: "rec_001"
            }
          },
          {
            commandType: "workflow.webhook.enqueue",
            fixtureContract: [{ id: "send_webhook.action.sample", kind: "action" }],
            id: "send_webhook",
            proposalTemplate: {
              body: {
                event: "record.updated"
              },
              destination: "https://example.test/hooks/cloudtable"
            }
          }
        ],
        trigger: {
          id: "field_changed",
          kind: "trigger",
          triggerEventTypes: ["cell.set"]
        },
        workflowId: "wf_qualify_lead"
      }
    });
    expect(result).toMatchObject({
      command: {
        payload: {
          definition: {
            actions: [
              {
                input: {
                  patch: {
                    title: "Bravo"
                  },
                  recordId: "rec_001"
                },
                operatorId: "update_record"
              },
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
    });
  });

  it("drafts owner conditions for workflow proposals from generic binding metadata", async () => {
    const ownerField = createRowOwnerWorkflowBindingField();
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: ownerField.config,
            fieldId: ownerField.fieldId,
            fieldKey: ownerField.fieldKey,
            fieldType: ownerField.fieldType,
            fieldTypeVersion: 1,
            label: "Owner"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: buildWorkflowBindingContract([ownerField]).bindings
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Notify sales ops when the owner is assigned.",
        fieldIds: ["fld_owner"],
        name: "Owner assigned follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_owner_assigned"
      }
    });

    expect(result).toMatchObject({
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
    });
  });

  it("drafts field-declared canonical alias conditions for workflow proposals from binding metadata", async () => {
    const assigneeField = createAssigneeAliasWorkflowBindingField();
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: assigneeField.config,
            fieldId: assigneeField.fieldId,
            fieldKey: assigneeField.fieldKey,
            fieldType: assigneeField.fieldType,
            fieldTypeVersion: 1,
            label: "Assignee"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: buildWorkflowBindingContract([assigneeField]).bindings
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Notify sales ops when the assignee is assigned.",
        fieldIds: ["fld_assignee"],
        name: "Assignee assigned follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_assignee_assigned"
      }
    });

    expect(result).toMatchObject({
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
      },
      command: {
        payload: {
          definition: {
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
      }
    });
  });

  it("drafts generic field presence conditions for workflow proposals from binding metadata", async () => {
    const noteField = createLongTextWorkflowBindingField();
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: noteField.config,
            fieldId: noteField.fieldId,
            fieldKey: noteField.fieldKey,
            fieldType: noteField.fieldType,
            fieldTypeVersion: 1,
            label: "Customer Note"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: buildWorkflowBindingContract([noteField]).bindings
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Notify sales ops when the customer note is set.",
        fieldIds: ["fld_note"],
        name: "Customer note follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_customer_note_set"
      }
    });

    expect(result).toMatchObject({
      kind: "workflow-proposal",
      proposal: {
        conditions: [
          {
            input: {
              fieldId: {
                path: "row.fields.customer_note.fieldId"
              },
              fieldType: {
                path: "row.fields.customer_note.fieldType"
              },
              value: {
                path: "row.fields.customer_note.value"
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
                    path: "row.fields.customer_note.fieldId"
                  },
                  fieldType: {
                    path: "row.fields.customer_note.fieldType"
                  },
                  value: {
                    path: "row.fields.customer_note.value"
                  }
                },
                operatorId: "is_not_empty"
              }
            ]
          }
        }
      }
    });
  });

  it("drafts configured status option comparisons for workflow proposals from binding metadata", async () => {
    const statusField = createStatusWorkflowBindingField();
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: statusField.config,
            fieldId: statusField.fieldId,
            fieldKey: statusField.fieldKey,
            fieldType: statusField.fieldType,
            fieldTypeVersion: 1,
            label: "Status"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: buildWorkflowBindingContract([statusField]).bindings
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "When status changes to Qualified, notify sales ops.",
        fieldIds: ["fld_status"],
        name: "Qualified follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_qualified_follow_up"
      }
    });

    expect(result).toMatchObject({
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
      },
      command: {
        payload: {
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
          }
        }
      }
    });
  });

  it("drafts relation contains-record conditions for workflow proposals from binding metadata", async () => {
    const relationField = createRelationWorkflowBindingField();
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: relationField.config,
            fieldId: relationField.fieldId,
            fieldKey: relationField.fieldKey,
            fieldType: relationField.fieldType,
            fieldTypeVersion: 1,
            label: "Related Companies"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: buildWorkflowBindingContract([relationField]).bindings
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Notify sales ops when related companies includes the parent account.",
        fieldIds: [relationField.fieldId],
        name: "Parent account follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_related_companies_parent"
      }
    });

    expect(result).toMatchObject({
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
      },
      command: {
        payload: {
          definition: {
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
      }
    });
  });

  it("drafts numeric comparisons for workflow proposals from binding metadata", async () => {
    const amountField = createNumberWorkflowBindingField();
    const workflow = buildWorkflowBindingContract([amountField]);

    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: amountField.config,
            fieldId: amountField.fieldId,
            fieldKey: amountField.fieldKey,
            fieldType: amountField.fieldType,
            fieldTypeVersion: 1,
            label: "Deal Amount"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow,
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Notify finance when deal amount is at most the approved cap.",
        fieldIds: ["fld_amount"],
        name: "Large deal guardrail",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_large_deal_guardrail"
      }
    });

    expect(result).toMatchObject({
      kind: "workflow-proposal",
      proposal: {
        conditions: [
          {
            input: {
              fieldId: {
                path: "row.fields.deal_amount.fieldId"
              },
              fieldType: {
                path: "row.fields.deal_amount.fieldType"
              },
              value: {
                path: "row.fields.deal_amount.value"
              },
              comparator: "lte",
              left: {
                path: "row.fields.deal_amount.value"
              },
              right: null
            },
            operatorId: "number_compare"
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
                    path: "row.fields.deal_amount.fieldId"
                  },
                  fieldType: {
                    path: "row.fields.deal_amount.fieldType"
                  },
                  value: {
                    path: "row.fields.deal_amount.value"
                  },
                  comparator: "lte",
                  left: {
                    path: "row.fields.deal_amount.value"
                  },
                  right: null
                },
                operatorId: "number_compare"
              }
            ]
          }
        }
      }
    });
  });

  it("drafts date comparisons for workflow proposals from binding metadata", async () => {
    const dueDateField = createDateWorkflowBindingField();
    const workflow = buildWorkflowBindingContract([dueDateField]);

    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: dueDateField.config,
            fieldId: dueDateField.fieldId,
            fieldKey: dueDateField.fieldKey,
            fieldType: dueDateField.fieldType,
            fieldTypeVersion: 1,
            label: "Due Date"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow,
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "Escalate when due date is on or before the contract deadline.",
        fieldIds: ["fld_due_date"],
        name: "Due date escalation",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_due_date_escalation"
      }
    });

    expect(result).toMatchObject({
      kind: "workflow-proposal",
      proposal: {
        conditions: [
          {
            input: {
              fieldId: {
                path: "row.fields.due_date.fieldId"
              },
              fieldType: {
                path: "row.fields.due_date.fieldType"
              },
              value: {
                path: "row.fields.due_date.value"
              },
              comparator: "on_or_before",
              left: {
                path: "row.fields.due_date.value"
              },
              right: null
            },
            operatorId: "date_compare"
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
                    path: "row.fields.due_date.fieldId"
                  },
                  fieldType: {
                    path: "row.fields.due_date.fieldType"
                  },
                  value: {
                    path: "row.fields.due_date.value"
                  },
                  comparator: "on_or_before",
                  left: {
                    path: "row.fields.due_date.value"
                  },
                  right: null
                },
                operatorId: "date_compare"
              }
            ]
          }
        }
      }
    });
  });

  it("drafts metadata-defined template.input conditions for workflow proposals without default field scaffolding", async () => {
    const registry = createRegistry({
      tableSchemaInspectionResult: {
        appId: "app_crm",
        fields: [
          {
            config: {
              options: [
                { id: "open", label: "Open", semantic: "todo" },
                { id: "qualified", label: "Qualified", semantic: "done" }
              ]
            },
            fieldId: "fld_status",
            fieldKey: "status",
            fieldType: "status.semantic",
            fieldTypeVersion: 1,
            label: "Status"
          }
        ],
        schemaEpoch: 3,
        tableId: "tbl_accounts",
        tableName: "Accounts",
        tableSchemaVersion: 2,
        tableSlug: "accounts",
        workflow: {
          bindings: {
            "row.conditions.status_qualified": {
              binding: "row.conditions.status_qualified",
              fieldId: "fld_status",
              fieldKey: "status",
              fieldType: "status.semantic",
              proposalHints: [
                {
                  operatorId: "equals",
                  matchPhrases: [
                    "changes to qualified",
                    "becomes qualified",
                    "is qualified",
                    "set to qualified",
                    "equals qualified"
                  ],
                  matchFieldPhrases: [
                    "{field} changes to Qualified",
                    "{field} becomes Qualified",
                    "{field} is Qualified",
                    "{field} set to Qualified",
                    "{field} equals Qualified"
                  ]
                }
              ],
              supportedOperatorIds: ["equals"],
              supportedOperators: supportedConditionOperatorManifests(["equals"]),
              template: {
                input: {
                  left: {
                    path: "row.fields.status.value"
                  },
                  right: "qualified"
                }
              }
            }
          }
        },
        workspaceId: "ws_demo"
      }
    });

    const result = await registry.invoke({
      toolId: "proposeWorkflow",
      input: {
        ...baseCommandInput(),
        actionIds: ["update_record"],
        businessRule: "When status changes to Qualified, notify sales ops.",
        fieldIds: ["fld_status"],
        name: "Qualified follow-up",
        tableId: "tbl_accounts",
        triggerId: "field_changed",
        workflowId: "wf_qualified_follow_up"
      }
    });

    expect(result).toMatchObject({
      kind: "workflow-proposal",
      proposal: {
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
        ]
      },
      command: {
        payload: {
          definition: {
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
            ]
          }
        }
      }
    });
  });

  it("builds explicit workflow lifecycle commands on the audited path", async () => {
    const registry = createRegistry();

    const updateDraft = await registry.invoke({
      toolId: "updateWorkflow",
      input: {
        ...baseCommandInput(),
        definition: {
          actions: [
            {
              input: {
                value: "draft-edit"
              },
              operatorId: "set_cell"
            }
          ],
          conditions: [],
          metadata: {
            status: "draft",
            tableId: "tbl_accounts"
          },
          trigger: {
            operatorId: "manual"
          },
          workflowId: "wf_follow_up"
        },
        name: "Follow Up Draft",
        tableId: "tbl_accounts",
        workflowId: "wf_follow_up"
      }
    });
    const publishDraft = await registry.invoke({
      toolId: "publishWorkflow",
      input: {
        ...baseCommandInput(),
        tableId: "tbl_accounts",
        workflowId: "wf_follow_up"
      }
    });
    const pauseDraft = await registry.invoke({
      toolId: "pauseWorkflow",
      input: {
        ...baseCommandInput(),
        tableId: "tbl_accounts",
        workflowId: "wf_follow_up"
      }
    });
    const runDraft = await registry.invoke({
      toolId: "runWorkflow",
      input: {
        ...baseCommandInput(),
        input: {
          source: "agent"
        },
        manualInvocationId: "manual_follow_up_1",
        tableId: "tbl_accounts",
        workflowId: "wf_follow_up"
      }
    });

    expect(updateDraft).toMatchObject({
      command: {
        commandType: "workflow.update",
        payload: {
          name: "Follow Up Draft",
          tableId: "tbl_accounts",
          workflowId: "wf_follow_up"
        },
        scope: "workflow",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/workflows/wf_follow_up"
        }
      ],
      kind: "command-draft"
    });
    expect(publishDraft).toMatchObject({
      command: {
        commandType: "workflow.publish",
        payload: {
          workflowId: "wf_follow_up"
        },
        scope: "workflow",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/workflows/wf_follow_up"
        }
      ],
      kind: "command-draft"
    });
    expect(pauseDraft).toMatchObject({
      command: {
        commandType: "workflow.pause",
        payload: {
          workflowId: "wf_follow_up"
        },
        scope: "workflow",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "update",
          path: "/workflows/wf_follow_up"
        }
      ],
      kind: "command-draft"
    });
    expect(runDraft).toMatchObject({
      command: {
        commandType: "workflow.manual",
        payload: {
          input: {
            source: "agent"
          },
          manualInvocationId: "manual_follow_up_1",
          workflowId: "wf_follow_up"
        },
        scope: "workflow",
        tableId: "tbl_accounts"
      },
      diffs: [
        {
          action: "create",
          path: "/workflows/wf_follow_up/runs/manual"
        }
      ],
      kind: "command-draft"
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

  it("strips non-writable record mutation fields from agent tool payloads", () => {
    const registry = createRegistry();
    const nonWritableSnapshot: EffectivePermissionSnapshot = {
      ...snapshot,
      fields: {
        ...snapshot.fields,
        customer_note: {
          ...snapshot.fields.customer_note,
          agent: true,
          write: false
        }
      }
    };

    const sanitizedCreateRecord = registry.sanitizeInput(
      "createRecord",
      {
        cells: {
          customer_note: "internal",
          status: "Open",
          title: "Acme"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      },
      fields,
      nonWritableSnapshot
    );
    const sanitizedUpdateCell = registry.sanitizeInput(
      "updateCell",
      {
        fieldId: "customer_note",
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts",
        value: "internal"
      },
      fields,
      nonWritableSnapshot
    );
    const sanitizedUpdateRecord = registry.sanitizeInput(
      "updateRecord",
      {
        patch: {
          customer_note: "internal",
          status: "Open",
          title: "Acme"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      },
      fields,
      nonWritableSnapshot
    );

    expect(sanitizedCreateRecord).toEqual({
      diagnostics: ["agent_non_writable:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        cells: {
          status: "Open",
          title: "Acme"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
      }
    });
    expect(sanitizedUpdateCell).toEqual({
      diagnostics: ["agent_non_writable:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {}
    });
    expect(sanitizedUpdateRecord).toEqual({
      diagnostics: ["agent_non_writable:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        patch: {
          status: "Open",
          title: "Acme"
        },
        recordId: "rec_accounts_001",
        tableId: "tbl_accounts"
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
        showEmptyGroups: true,
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
    expect(viewDraft).toMatchObject({
      command: {
        commandType: "view.create",
        payload: {
          groupByFieldId: "status",
          showEmptyGroups: true,
          tableId: "tbl_accounts",
          viewId: "view_open_accounts",
          viewName: "Open Accounts",
          visibleFieldIds: ["title", "status"]
        }
      },
      kind: "command-draft"
    });
    expect(workflowProposal).toMatchObject({
      command: {
        commandType: "workflow.create",
        payload: {
          workflowId: "wf_follow_up"
        }
      },
      kind: "workflow-proposal",
      proposal: {
        actions: [
          {
            commandType: "record.update",
            fixtureContract: [{ id: "update_record.action.sample", kind: "action" }],
            id: "update_record",
            proposalTemplate: {
              patch: {
                title: "Bravo"
              },
              recordId: "rec_001"
            }
          }
        ],
        trigger: {
          id: "field_changed",
          kind: "trigger",
          triggerEventTypes: ["cell.set"]
        },
        workflowId: "wf_follow_up"
      }
    });
  });
});
