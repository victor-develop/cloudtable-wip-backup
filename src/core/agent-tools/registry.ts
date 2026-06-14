import type { CommandBus } from "../commands/command-bus";
import type { CommandEnvelope } from "../commands/types";
import { readComputedFieldConfig } from "../field-types/computed";
import type {
  EffectivePermissionSnapshot,
  PermissionEngine,
  PermissionFieldDescriptor
} from "../permissions/types";
import type { ViewPlanner } from "../views/planner";
import { draftWorkflowConditionsFromMetadata } from "../workflows/authoring";
import { normalizeWorkflowAuthoringMetadata } from "../workflows/binding-metadata";
import { serializeWorkflowOperatorManifest } from "../workflows/manifest";
import type {
  WorkflowActionDefinition,
  WorkflowActionManifest,
  WorkflowAggregateDefinition,
  WorkflowAuthoringMetadata,
  WorkflowDefinitionMetadata,
  WorkflowOperatorRegistry,
  WorkflowRelatedTableResolver,
  WorkflowTriggerDefinition,
  WorkflowTriggerManifest
} from "../workflows/types";
import type {
  ActivityHistoryReader,
  AppInspector,
  AgentToolAuditDiff,
  AgentToolDefinition,
  AgentToolId,
  AgentToolInvocation,
  AgentToolInvocationResult,
  AgentToolRegistry,
  AgentToolSanitizationResult,
  PermissionPersonaPreviewReader,
  RecordInspector,
  TableSchemaInspector,
  ViewDefinitionInspector,
  WorkflowDeadLetterReplayRequester,
  ViewQueryReader,
  WorkflowDefinitionInspector,
  WorkflowHistoryReader,
  WorkflowRunReader,
  WorkflowTestPreviewReader,
  WorkspaceInspector
} from "./types";

type CreateAgentToolRegistryDeps = {
  permissionEngine: PermissionEngine;
  commandBus: CommandBus;
  viewPlanner: ViewPlanner;
  activityHistoryReader: ActivityHistoryReader;
  appInspector: AppInspector;
  tableSchemaInspector: TableSchemaInspector;
  viewDefinitionInspector: ViewDefinitionInspector;
  workflowDefinitionInspector: WorkflowDefinitionInspector;
  workflowTestPreviewReader?: WorkflowTestPreviewReader;
  permissionPersonaPreviewReader: PermissionPersonaPreviewReader;
  recordInspector: RecordInspector;
  viewQueryReader: ViewQueryReader;
  workflowOperatorRegistry: WorkflowOperatorRegistry;
  workflowHistoryReader: WorkflowHistoryReader;
  workflowRunReader: WorkflowRunReader;
  workflowDeadLetterReplayRequester: WorkflowDeadLetterReplayRequester;
  workspaceInspector: WorkspaceInspector;
};

const jsonBooleanSchema = {
  type: "boolean"
} as const;

const jsonStringSchema = {
  type: "string"
} as const;

const jsonUnknownSchema = {
  type: "unknown"
} as const;

const jsonFieldRefSchema = {
  properties: {
    fieldId: jsonStringSchema
  },
  type: "object"
} as const;

const fieldTypeManifestSchema = {
  properties: {
    capabilities: {
      type: "object"
    },
    configSchema: {
      type: "object"
    },
    defaultConfig: {
      type: "object"
    },
    permissionBehavior: {
      type: "object"
    },
    supportedConditionOperators: {
      items: jsonStringSchema,
      type: "array"
    },
    supportedSortModes: {
      items: jsonStringSchema,
      type: "array"
    },
    type: jsonStringSchema,
    valueSchema: {
      type: "object"
    },
    version: {
      type: "number"
    }
  },
  type: "object"
} as const;

const workflowOperatorFixtureManifestSchema = {
  properties: {
    id: jsonStringSchema,
    kind: jsonStringSchema
  },
  type: "object"
} as const;

const workflowOperatorManifestSchema = {
  properties: {
    commandScope: jsonStringSchema,
    commandType: jsonStringSchema,
    fixtureContract: {
      items: workflowOperatorFixtureManifestSchema,
      type: "array"
    },
    id: jsonStringSchema,
    idempotencyMode: jsonStringSchema,
    inputSchema: {
      type: "object"
    },
    kind: jsonStringSchema,
    outputSchema: {
      type: "object"
    },
    purity: jsonStringSchema,
    requiredCapabilities: {
      items: jsonStringSchema,
      type: "array"
    },
    retryClass: jsonStringSchema,
    timeoutClass: jsonStringSchema,
    triggerEventTypes: {
      items: jsonStringSchema,
      type: "array"
    },
    version: {
      type: "number"
    }
  },
  type: "object"
} as const;

const agentToolManifestSchema = {
  properties: {
    binding: {
      type: "object"
    },
    description: jsonStringSchema,
    fieldBinding: jsonStringSchema,
    fieldIds: {
      items: jsonStringSchema,
      type: "array"
    },
    id: jsonStringSchema,
    inputSchema: {
      type: "object"
    },
    mutating: jsonBooleanSchema,
    mutationTarget: jsonStringSchema,
    outputSchema: {
      type: "object"
    },
    phase: jsonStringSchema,
    requiresConfirmation: jsonBooleanSchema,
    scope: jsonStringSchema,
    successorToolId: jsonStringSchema
  },
  type: "object"
} as const;

const tools: AgentToolDefinition[] = [
  {
    binding: {
      kind: "query-service",
      service: "workspaceInspector"
    },
    description: "Inspect the current workspace schema, view surface, workflow surface, and catalog.",
    fieldBinding: "none",
    id: "inspectWorkspace",
    inputSchema: {
      properties: {
        include: {
          items: jsonStringSchema,
          type: "array"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        apps: {
          type: "array"
        },
        catalog: {
          properties: {
            agentTools: {
              items: agentToolManifestSchema,
              type: "array"
            },
            fieldTypes: {
              items: fieldTypeManifestSchema,
              type: "array"
            },
            workflowOperators: {
              items: workflowOperatorManifestSchema,
              type: "array"
            }
          },
          type: "object"
        },
        tables: {
          type: "array"
        },
        views: {
          type: "array"
        },
        workflows: {
          type: "array"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "app"
  },
  {
    binding: {
      kind: "query-service",
      service: "appInspector"
    },
    description:
      "Inspect one app/base through the canonical bootstrap metadata surface, including slug and table membership.",
    fieldBinding: "none",
    id: "inspectApp",
    inputSchema: {
      properties: {
        appId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        app: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "app"
  },
  {
    binding: {
      kind: "query-service",
      service: "tableSchemaInspector"
    },
    description:
      "Inspect one table schema through the canonical metadata surface used by direct table schema ingress.",
    fieldBinding: "all-visible-fields",
    id: "inspectTableSchema",
    inputSchema: {
      properties: {
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        schema: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "table"
  },
  {
    binding: {
      kind: "query-service",
      service: "viewDefinitionInspector"
    },
    description:
      "Inspect one saved view definition through the canonical metadata surface used by direct view-definition ingress.",
    fieldBinding: "all-visible-fields",
    id: "inspectViewDefinition",
    inputSchema: {
      properties: {
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        view: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "view"
  },
  {
    binding: {
      kind: "query-service",
      service: "workflowDefinitionInspector"
    },
    description:
      "Inspect one saved workflow definition through the canonical metadata surface used by direct workflow-definition ingress.",
    fieldBinding: "all-visible-fields",
    id: "inspectWorkflowDefinition",
    inputSchema: {
      properties: {
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        workflow: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "workflow"
  },
  {
    binding: {
      kind: "query-service",
      service: "workflowTestPreviewReader"
    },
    description:
      "Preview a selected-record reactive workflow run without committing mutations, including trigger, condition, action, and permission diagnostics.",
    fieldBinding: "none",
    id: "previewWorkflowTest",
    inputSchema: {
      properties: {
        recordId: jsonStringSchema,
        selectedFieldId: jsonStringSchema,
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        preview: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: false,
    scope: "workflow"
  },
  {
    binding: {
      kind: "query-service",
      service: "permissionEngine"
    },
    description:
      "Explain field visibility, redaction, writability, workflow visibility, and agent visibility for the current principal and scope.",
    fieldBinding: "explicit-field-ids",
    id: "explainPermissions",
    inputSchema: {
      properties: {
        fieldId: jsonStringSchema,
        fieldType: jsonStringSchema,
        recordId: jsonStringSchema,
        surfaces: {
          items: jsonStringSchema,
          type: "array"
        },
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        explanation: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "table"
  },
  {
    binding: {
      kind: "query-service",
      service: "permissionPersonaPreviewReader"
    },
    description:
      "Preview the effective saved-view persona surface for the current principal, including hidden, redacted, read-only, workflow, and agent-tool constraints.",
    fieldBinding: "all-visible-fields",
    id: "previewPermissionPersona",
    inputSchema: {
      properties: {
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        preview: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: false,
    scope: "view"
  },
  {
    binding: {
      kind: "query-service",
      service: "recordInspector"
    },
    description:
      "Inspect one live record through the canonical permissioned projection surface used by direct runtime record reads.",
    fieldBinding: "all-visible-fields",
    id: "inspectRecord",
    inputSchema: {
      properties: {
        recordId: jsonStringSchema,
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        record: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "table"
  },
  {
    binding: {
      kind: "query-service",
      service: "viewQueryReader"
    },
    description:
      "Query one saved view through the canonical permissioned view-query surface with existing hidden-field and protected-filter guardrails.",
    fieldBinding: "all-visible-fields",
    id: "queryView",
    inputSchema: {
      properties: {
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        view: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "view"
  },
  {
    binding: {
      kind: "query-service",
      service: "activityHistoryReader"
    },
    description:
      "Read bounded table or record activity history through the same audited activity feed surface used by runtime observers.",
    fieldBinding: "none",
    id: "readActivityHistory",
    inputSchema: {
      properties: {
        beforeTableSequence: {
          type: "number"
        },
        limit: {
          type: "number"
        },
        recordId: jsonStringSchema,
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        activity: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "table"
  },
  {
    binding: {
      kind: "query-service",
      service: "activityHistoryReader"
    },
    description:
      "Read bounded workspace activity history through the same audited activity feed surface used by runtime observers.",
    fieldBinding: "none",
    id: "readWorkspaceActivityHistory",
    inputSchema: {
      properties: {
        beforeWorkspaceSequence: {
          type: "number"
        },
        limit: {
          type: "number"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        activity: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "app"
  },
  {
    binding: {
      kind: "query-service",
      service: "activityHistoryReader"
    },
    description:
      "Read bounded app activity history through the same audited activity feed surface used by runtime observers.",
    fieldBinding: "none",
    id: "readAppActivityHistory",
    inputSchema: {
      properties: {
        appId: jsonStringSchema,
        beforeWorkspaceSequence: {
          type: "number"
        },
        limit: {
          type: "number"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        activity: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "app"
  },
  {
    binding: {
      kind: "query-service",
      service: "workflowHistoryReader"
    },
    description:
      "Read workflow execution history through the same audited workflow-operations ingress used by direct runtime observers.",
    fieldBinding: "none",
    id: "readWorkflowHistory",
    inputSchema: {
      properties: {
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        history: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "workflow"
  },
  {
    binding: {
      kind: "query-service",
      service: "workflowRunReader"
    },
    description:
      "Read one workflow run detail through the same audited workflow-operations ingress used by direct runtime observers.",
    fieldBinding: "none",
    id: "readWorkflowRunDetail",
    inputSchema: {
      properties: {
        workflowRunId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        run: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "workflow"
  },
  {
    binding: {
      kind: "workflow-operation",
      operation: "replay-dead-letter"
    },
    description:
      "Prepare a bounded dead-letter replay request for an eligible workflow step through the workflow operations contract.",
    fieldBinding: "none",
    id: "prepareWorkflowDeadLetterReplay",
    inputSchema: {
      properties: {
        deadLetterId: jsonStringSchema,
        replayRequestId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        diffs: {
          type: "array"
        },
        request: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "workflow",
    successorToolId: "requestWorkflowDeadLetterReplay"
  },
  {
    binding: {
      kind: "workflow-operation",
      operation: "replay-dead-letter"
    },
    description:
      "Request replay for an eligible workflow dead letter through the same workflow operations ingress used by direct runtime operators.",
    fieldBinding: "none",
    id: "requestWorkflowDeadLetterReplay",
    inputSchema: {
      properties: {
        deadLetterId: jsonStringSchema,
        replayRequestId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "workflow",
    outputSchema: {
      properties: {
        deadLetterId: jsonStringSchema,
        message: jsonStringSchema,
        reason: jsonStringSchema,
        replayRequestId: jsonStringSchema,
        status: jsonStringSchema
      },
      type: "object"
    },
    phase: "execute",
    requiresConfirmation: true,
    scope: "workflow"
  },
  {
    binding: {
      commandType: "base.create",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit base.create command payload for a new workspace app.",
    fieldBinding: "none",
    id: "createApp",
    inputSchema: {
      properties: {
        appId: jsonStringSchema,
        appName: jsonStringSchema,
        appSlug: jsonStringSchema,
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "app",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "table.create",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit table.create command payload for a new app table.",
    fieldBinding: "none",
    id: "createTable",
    inputSchema: {
      properties: {
        appId: jsonStringSchema,
        commandId: jsonStringSchema,
        description: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        primaryField: {
          properties: {
            fieldId: jsonStringSchema,
            fieldType: jsonStringSchema,
            name: jsonStringSchema,
            required: jsonBooleanSchema
          },
          type: "object"
        },
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        tableName: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "field.create",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit field.create command payload for a table field.",
    fieldBinding: "none",
    id: "createField",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        config: {
          type: "object"
        },
        fieldId: jsonStringSchema,
        fieldType: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        name: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        required: jsonBooleanSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "view.create",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit view.create command payload from visible field and grouping choices.",
    fieldBinding: "explicit-field-ids",
    id: "createView",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        filterFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        groupByFieldId: jsonStringSchema,
        showEmptyGroups: {
          type: "boolean"
        },
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        sortFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        viewName: jsonStringSchema,
        visibleFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "view",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "view",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "view.update",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit view.update command payload for an existing saved view.",
    fieldBinding: "explicit-field-ids",
    id: "updateView",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        filterFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        groupByFieldId: jsonStringSchema,
        showEmptyGroups: {
          type: "boolean"
        },
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        sortFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        viewName: jsonStringSchema,
        visibleFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "view",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "view",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "view.delete",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit view.delete command payload for an existing saved view.",
    fieldBinding: "none",
    id: "deleteView",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        viewId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "view",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "view",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "field.permission.configure",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit field.permission.configure command payload for one principal and field.",
    fieldBinding: "explicit-field-ids",
    id: "configureFieldPermission",
    inputSchema: {
      properties: {
        agent: jsonBooleanSchema,
        commandId: jsonStringSchema,
        fieldId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        principalId: jsonStringSchema,
        read: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workflow: jsonBooleanSchema,
        workspaceId: jsonStringSchema,
        write: jsonBooleanSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "permissions",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "app",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "field.update",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit field.update command payload for a reviewed field config mutation.",
    fieldBinding: "explicit-field-ids",
    id: "updateField",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        config: {
          type: "object"
        },
        fieldId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "app",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "field.archive",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit field.archive command payload for a reviewed schema archive mutation.",
    fieldBinding: "explicit-field-ids",
    id: "archiveField",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        fieldId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "app",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "field.reorder",
      kind: "command-builder",
      scope: "workspace"
    },
    description: "Build an explicit field.reorder command payload for one reviewed table field order mutation.",
    fieldBinding: "explicit-field-ids",
    id: "reorderFields",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        fieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "schema",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "app",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "record.create",
      kind: "command-builder",
      scope: "table"
    },
    description: "Build an explicit record.create command payload from agent-provided cell values.",
    fieldBinding: "all-visible-fields",
    id: "createRecord",
    inputSchema: {
      properties: {
        cells: {
          type: "object"
        },
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        recordId: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "record.update",
      kind: "command-builder",
      scope: "table"
    },
    description: "Build an explicit record.update command payload from a reviewed record patch.",
    fieldBinding: "all-visible-fields",
    id: "updateRecord",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        patch: {
          type: "object"
        },
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        recordId: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "records.bulk_patch",
      kind: "command-builder",
      scope: "table"
    },
    description:
      "Build an explicit records.bulk_patch command payload from a reviewed multi-record patch set.",
    fieldBinding: "all-visible-fields",
    id: "bulkUpdateRecords",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        updates: {
          items: {
            properties: {
              patch: {
                type: "object"
              },
              recordId: jsonStringSchema
            },
            type: "object"
          },
          type: "array"
        },
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "record.archive",
      kind: "command-builder",
      scope: "table"
    },
    description: "Build an explicit record.archive command payload for a reviewed archive mutation.",
    fieldBinding: "none",
    id: "archiveRecord",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        recordId: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "cell.set",
      kind: "command-builder",
      scope: "table"
    },
    description: "Build an explicit cell.set command payload for one reviewed record cell mutation.",
    fieldBinding: "explicit-field-ids",
    id: "updateCell",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        fieldId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        recordId: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        value: jsonUnknownSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "records",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "table",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      kind: "proposal-service",
      service: "workflowOperatorRegistry"
    },
    description: "Propose a workflow trigger and action plan using the registered workflow operators.",
    fieldBinding: "explicit-field-ids",
    id: "proposeWorkflow",
    inputSchema: {
      properties: {
        actionIds: {
          items: jsonStringSchema,
          type: "array"
        },
        businessRule: jsonStringSchema,
        fieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        relatedSourceFieldId: jsonStringSchema,
        relatedTargetFieldId: jsonStringSchema,
        rollupFieldIds: {
          items: jsonStringSchema,
          type: "array"
        },
        name: jsonStringSchema,
        syncSourceFieldId: jsonStringSchema,
        syncTargetFieldId: jsonStringSchema,
        tableId: jsonStringSchema,
        triggerId: jsonStringSchema,
        workflowId: jsonStringSchema
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        diagnostics: {
          items: jsonStringSchema,
          type: "array"
        },
        diffs: {
          type: "array"
        },
        proposal: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "draft",
    requiresConfirmation: false,
    scope: "workflow",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "workflow.update",
      kind: "command-builder",
      scope: "workflow"
    },
    description: "Build an explicit workflow.update command payload for revising a saved workflow draft.",
    fieldBinding: "none",
    id: "updateWorkflow",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        definition: {
          type: "object"
        },
        idempotencyKey: jsonStringSchema,
        name: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "workflow",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "workflow",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "workflow.publish",
      kind: "command-builder",
      scope: "workflow"
    },
    description: "Build an explicit workflow.publish command payload for a reviewed workflow draft.",
    fieldBinding: "none",
    id: "publishWorkflow",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "workflow",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "workflow",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "workflow.pause",
      kind: "command-builder",
      scope: "workflow"
    },
    description: "Build an explicit workflow.pause command payload for a published workflow.",
    fieldBinding: "none",
    id: "pauseWorkflow",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "workflow",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "workflow",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      commandType: "workflow.manual",
      kind: "command-builder",
      scope: "workflow"
    },
    description: "Build an explicit workflow.manual command payload for a manual workflow run.",
    fieldBinding: "none",
    id: "runWorkflow",
    inputSchema: {
      properties: {
        commandId: jsonStringSchema,
        idempotencyKey: jsonStringSchema,
        input: {
          type: "object"
        },
        manualInvocationId: jsonStringSchema,
        permissionsVersion: {
          type: "number"
        },
        permissionScopeHash: jsonStringSchema,
        schemaEpoch: {
          type: "number"
        },
        tableId: jsonStringSchema,
        workflowId: jsonStringSchema,
        workspaceId: jsonStringSchema
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "workflow",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: true,
    scope: "workflow",
    successorToolId: "dryRunCommand"
  },
  {
    binding: {
      kind: "command-bus",
      operation: "dry-run"
    },
    description: "Dry-run an explicit command payload through the command bus for audit-ready diagnostics.",
    fieldBinding: "none",
    id: "dryRunCommand",
    inputSchema: {
      properties: {
        command: {
          type: "object"
        }
      },
      type: "object"
    },
    mutating: false,
    mutationTarget: "none",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        diffs: {
          type: "array"
        },
        result: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "preview",
    requiresConfirmation: false,
    scope: "app",
    successorToolId: "executeCommand"
  },
  {
    binding: {
      kind: "command-bus",
      operation: "execute"
    },
    description: "Execute a reviewed explicit command payload through the normal command bus.",
    fieldBinding: "none",
    id: "executeCommand",
    inputSchema: {
      properties: {
        command: {
          type: "object"
        }
      },
      type: "object"
    },
    mutating: true,
    mutationTarget: "command",
    outputSchema: {
      properties: {
        command: {
          type: "object"
        },
        result: {
          type: "object"
        }
      },
      type: "object"
    },
    phase: "execute",
    requiresConfirmation: true,
    scope: "app"
  }
];

const fieldIdArrayKeys = new Set([
  "fieldIds",
  "filterFieldIds",
  "impactedFieldIds",
  "proposedFieldIds",
  "sortFieldIds",
  "visibleFieldIds"
]);

const singularFieldIdKeys = new Set([
  "fieldId",
  "groupByFieldId",
  "targetFieldId"
]);

export function createAgentToolRegistry({
  permissionEngine,
  commandBus,
  viewPlanner,
  activityHistoryReader,
  appInspector,
  tableSchemaInspector,
  viewDefinitionInspector,
  workflowDefinitionInspector,
  workflowTestPreviewReader,
  permissionPersonaPreviewReader,
  recordInspector,
  viewQueryReader,
  workflowOperatorRegistry,
  workflowHistoryReader,
  workflowRunReader,
  workflowDeadLetterReplayRequester,
  workspaceInspector
}: CreateAgentToolRegistryDeps): AgentToolRegistry {
  return {
    list() {
      return [...tools];
    },
    get(toolId) {
      return tools.find((tool) => tool.id === toolId);
    },
    require(toolId) {
      const tool = this.get(toolId);
      if (!tool) {
        throw new Error(`Unknown agent tool: ${toolId}`);
      }

      return tool;
    },
    async invoke(invocation) {
      this.require(invocation.toolId);

      switch (invocation.toolId) {
        case "inspectWorkspace":
          return {
            kind: "workspace-inspection",
            workspace: await Promise.resolve(workspaceInspector.inspect(invocation.input))
          };
        case "inspectApp":
          return {
            app: await Promise.resolve(appInspector.inspect(invocation.input)),
            kind: "app-inspection"
          };
        case "inspectTableSchema":
          return {
            kind: "table-schema-inspection",
            schema: await Promise.resolve(tableSchemaInspector.read(invocation.input))
          };
        case "inspectViewDefinition":
          return {
            kind: "view-definition-inspection",
            view: await Promise.resolve(viewDefinitionInspector.read(invocation.input))
          };
        case "inspectWorkflowDefinition":
          return {
            kind: "workflow-definition-inspection",
            workflow: await Promise.resolve(workflowDefinitionInspector.read(invocation.input))
          };
        case "previewWorkflowTest":
          return {
            kind: "workflow-test-preview",
            preview: await Promise.resolve(
              workflowTestPreviewReader?.read(invocation.input) ?? {
                diagnostics: ["workflow_test_preview_unavailable"],
                message: "Workflow test preview reader is not configured.",
                reason: "workflow_test_preview_unavailable",
                status: "rejected",
                trigger: {},
                workflowId: invocation.input.workflowId,
                workflowVersionId: null
              }
            )
          };
        case "explainPermissions": {
          const fieldType = invocation.input.fieldType;
          if (!fieldType) {
            throw new Error(`fieldType is required for explainPermissions on ${invocation.input.fieldId}.`);
          }

          return {
            explanation: {
              ...permissionEngine.explainFieldAccess(
                {
                  fieldId: invocation.input.fieldId,
                  fieldType
                },
                invocation.input.surfaces
              ),
              scope: {
                recordId: invocation.input.recordId ?? null,
                tableId: invocation.input.tableId ?? null,
                viewId: invocation.input.viewId ?? null,
                workspaceId: invocation.input.workspaceId
              }
            },
            kind: "permission-explanation"
          };
        }
        case "previewPermissionPersona":
          return {
            kind: "permission-persona-preview",
            preview: await Promise.resolve(permissionPersonaPreviewReader.read(invocation.input))
          };
        case "inspectRecord":
          return {
            kind: "record-inspection",
            record: await Promise.resolve(recordInspector.read(invocation.input))
          };
        case "queryView":
          return {
            kind: "view-query",
            view: await Promise.resolve(viewQueryReader.read(invocation.input))
          };
        case "readActivityHistory":
          return {
            activity: await Promise.resolve(activityHistoryReader.read(invocation.input)),
            kind: "activity-history"
          };
        case "readWorkspaceActivityHistory":
          return {
            activity: await Promise.resolve(activityHistoryReader.read(invocation.input)),
            kind: "activity-history"
          };
        case "readAppActivityHistory":
          return {
            activity: await Promise.resolve(activityHistoryReader.read(invocation.input)),
            kind: "activity-history"
          };
        case "readWorkflowHistory":
          return {
            history: await Promise.resolve(workflowHistoryReader.read(invocation.input)),
            kind: "workflow-history"
          };
        case "readWorkflowRunDetail":
          return {
            kind: "workflow-run-detail",
            run: await Promise.resolve(workflowRunReader.read(invocation.input))
          };
        case "prepareWorkflowDeadLetterReplay": {
          const replayRequestId =
            invocation.input.replayRequestId ??
            `dead-letter-replay:${invocation.input.deadLetterId}`;
          return {
            diffs: [
              {
                action: "propose",
                after: {
                  deadLetterId: invocation.input.deadLetterId,
                  replayRequestId
                },
                note: "Request replay for one eligible workflow dead letter.",
                path: "$.workflowDeadLetterReplay"
              }
            ],
            kind: "workflow-dead-letter-replay-draft",
            request: {
              deadLetterId: invocation.input.deadLetterId,
              replayRequestId,
              workspaceId: invocation.input.workspaceId
            }
          };
        }
        case "requestWorkflowDeadLetterReplay":
          return {
            kind: "workflow-dead-letter-replay",
            ...(await Promise.resolve(workflowDeadLetterReplayRequester.requestReplay(invocation.input)))
          };
        case "createApp": {
          const command = buildCommandEnvelope("base.create", "workspace", invocation.input, {
            baseId: invocation.input.appId,
            name: invocation.input.appName,
            slug: invocation.input.appSlug
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "createTable": {
          const command = buildCommandEnvelope("table.create", "workspace", invocation.input, {
            appId: invocation.input.appId,
            description: invocation.input.description ?? null,
            primaryField: invocation.input.primaryField,
            tableId: invocation.input.tableId,
            tableName: invocation.input.tableName
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "createField": {
          const command = buildCommandEnvelope("field.create", "workspace", invocation.input, {
            config: invocation.input.config ?? {},
            fieldId: invocation.input.fieldId,
            fieldType: invocation.input.fieldType,
            name: invocation.input.name,
            required: invocation.input.required ?? false,
            tableId: invocation.input.tableId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "createView": {
          const command = buildCommandEnvelope("view.create", "workspace", invocation.input, {
            filterFieldIds: invocation.input.filterFieldIds ?? [],
            filters: invocation.input.filters ?? [],
            groupByFieldId: invocation.input.groupByFieldId ?? null,
            planner: viewPlanner.describe(),
            showEmptyGroups: invocation.input.showEmptyGroups,
            sortFieldIds: invocation.input.sortFieldIds ?? [],
            sorts: invocation.input.sorts ?? [],
            tableId: invocation.input.tableId,
            viewId: invocation.input.viewId,
            viewName: invocation.input.viewName,
            visibleFieldIds: invocation.input.visibleFieldIds
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "updateView": {
          const command = buildCommandEnvelope("view.update", "workspace", invocation.input, {
            filterFieldIds: invocation.input.filterFieldIds ?? [],
            filters: invocation.input.filters ?? [],
            groupByFieldId: invocation.input.groupByFieldId ?? null,
            planner: viewPlanner.describe(),
            showEmptyGroups: invocation.input.showEmptyGroups,
            sortFieldIds: invocation.input.sortFieldIds ?? [],
            sorts: invocation.input.sorts ?? [],
            tableId: invocation.input.tableId,
            viewId: invocation.input.viewId,
            viewName: invocation.input.viewName,
            visibleFieldIds: invocation.input.visibleFieldIds
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "deleteView": {
          const command = buildCommandEnvelope("view.delete", "workspace", invocation.input, {
            tableId: invocation.input.tableId,
            viewId: invocation.input.viewId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "configureFieldPermission": {
          const command = buildCommandEnvelope(
            "field.permission.configure",
            "workspace",
            invocation.input,
            {
              fieldId: invocation.input.fieldId,
              policy: {
                agent: invocation.input.agent,
                read: invocation.input.read,
                workflow: invocation.input.workflow,
                write: invocation.input.write
              },
              principalId: invocation.input.principalId,
              tableId: invocation.input.tableId
            }
          );

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "updateField": {
          const command = buildCommandEnvelope("field.update", "workspace", invocation.input, {
            config: invocation.input.config,
            fieldId: invocation.input.fieldId,
            tableId: invocation.input.tableId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "archiveField": {
          const command = buildCommandEnvelope("field.archive", "workspace", invocation.input, {
            fieldId: invocation.input.fieldId,
            tableId: invocation.input.tableId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "reorderFields": {
          const command = buildCommandEnvelope("field.reorder", "workspace", invocation.input, {
            fieldIds: invocation.input.fieldIds ?? [],
            tableId: invocation.input.tableId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "createRecord": {
          const command = buildCommandEnvelope("record.create", "table", invocation.input, {
            cells: invocation.input.cells ?? {},
            recordId: invocation.input.recordId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "updateRecord": {
          const command = buildCommandEnvelope("record.update", "table", invocation.input, {
            patch: invocation.input.patch,
            recordId: invocation.input.recordId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "bulkUpdateRecords": {
          const command = buildCommandEnvelope("records.bulk_patch", "table", invocation.input, {
            updates: invocation.input.updates
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "archiveRecord": {
          const command = buildCommandEnvelope("record.archive", "table", invocation.input, {
            recordId: invocation.input.recordId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "updateCell": {
          const command = buildCommandEnvelope("cell.set", "table", invocation.input, {
            fieldId: invocation.input.fieldId,
            recordId: invocation.input.recordId,
            value: invocation.input.value
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "proposeWorkflow": {
          const diagnostics: string[] = [];
          const tableSchema = await Promise.resolve(
            tableSchemaInspector.read({
              tableId: invocation.input.tableId,
              workspaceId: invocation.input.workspaceId
            })
          );
          const authoringMetadata = readWorkflowAuthoringMetadata(tableSchema);
          const setCellAction = workflowOperatorRegistry.get("set_cell");
          const syncRelatedFieldAction = workflowOperatorRegistry.get("sync_related_field");
          const crossTableSync = await buildCrossTableSyncProposalTemplate({
            diagnostics,
            relatedSourceFieldId: invocation.input.relatedSourceFieldId,
            relatedTargetFieldId: invocation.input.relatedTargetFieldId,
            sourceTableId: invocation.input.tableId,
            syncRelatedFieldAction:
              syncRelatedFieldAction && syncRelatedFieldAction.kind === "action"
                ? syncRelatedFieldAction
                : null,
            syncSourceFieldId: invocation.input.syncSourceFieldId,
            syncTargetFieldId: invocation.input.syncTargetFieldId,
            tableSchemaInspector,
            workspaceId: invocation.input.workspaceId,
            workspaceInspector
          });
          const reactiveRollup = await buildReactiveRollupProposalTemplate({
            diagnostics,
            rollupFieldIds: invocation.input.rollupFieldIds ?? [],
            setCellAction: setCellAction && setCellAction.kind === "action" ? setCellAction : null,
            sourceTableId: invocation.input.tableId,
            tableSchemaInspector,
            workspaceId: invocation.input.workspaceId,
            workspaceInspector
          });
          const trigger = workflowOperatorRegistry.get(invocation.input.triggerId);
          const triggerManifest =
            trigger && trigger.kind === "trigger"
              ? toWorkflowTriggerProposal(trigger)
              : {
                  id: invocation.input.triggerId,
                  kind: "trigger" as const
                };
          if (!trigger || trigger.kind !== "trigger") {
            diagnostics.push(`unknown_trigger:${invocation.input.triggerId}`);
          }

          const actions = invocation.input.actionIds.flatMap((actionId) => {
            const action = workflowOperatorRegistry.get(actionId);
            if (!action || action.kind !== "action") {
              diagnostics.push(`unknown_action:${actionId}`);
              return [];
            }

            return [action];
          });
          const hasCrossTableSyncInputs =
            invocation.input.syncSourceFieldId !== undefined ||
            invocation.input.syncTargetFieldId !== undefined ||
            invocation.input.relatedSourceFieldId !== undefined ||
            invocation.input.relatedTargetFieldId !== undefined;
          const draftedActionBindings = [
            ...(crossTableSync.action ? [crossTableSync.action] : []),
            ...reactiveRollup.actions,
            ...actions
              .filter(
                (action) =>
                  action.id !== "set_cell" &&
                  !(
                    (crossTableSync.action !== null || hasCrossTableSyncInputs) &&
                    action.id === "sync_related_field"
                  )
              )
              .map((action) => ({
                input: cloneWorkflowActionInput(action.proposalTemplate),
                operatorId: action.id
              }))
          ];
          const proposalActions = [
            ...(crossTableSync.actionProposal ? [crossTableSync.actionProposal] : []),
            ...reactiveRollup.actionProposals,
            ...actions
              .filter(
                (action) =>
                  action.id !== "set_cell" &&
                  !(
                    (crossTableSync.actionProposal !== null || hasCrossTableSyncInputs) &&
                    action.id === "sync_related_field"
                  )
              )
              .map(toWorkflowActionProposal)
          ];
          const proposalMetadataEntries = [
            crossTableSync.metadata,
            reactiveRollup.metadata
          ].filter((entry): entry is WorkflowDefinitionMetadata => entry !== null);
          const proposalMetadata: WorkflowDefinitionMetadata = {
            businessRule: invocation.input.businessRule,
            name: invocation.input.name,
            ...mergeWorkflowDefinitionMetadata(proposalMetadataEntries),
            status: "draft",
            tableId: invocation.input.tableId
          };
          const triggerFieldIds =
            invocation.input.fieldIds && invocation.input.fieldIds.length > 0
              ? invocation.input.fieldIds
              : [
                  ...new Set([
                    ...crossTableSync.triggerFieldIds,
                    ...reactiveRollup.triggerFieldIds
                  ])
                ];
          const conditionFieldIds =
            invocation.input.fieldIds && invocation.input.fieldIds.length > 0
              ? invocation.input.fieldIds
              : crossTableSync.triggerFieldIds.length > 0
                ? [crossTableSync.triggerFieldIds[0]!]
                : reactiveRollup.triggerFieldIds;

          const proposal = {
            actions: proposalActions,
            businessRule: invocation.input.businessRule,
            conditions: draftWorkflowConditionsFromMetadata(authoringMetadata, {
              businessRule: invocation.input.businessRule,
              fieldIds: conditionFieldIds
            }),
            metadata: proposalMetadata,
            name: invocation.input.name,
            tableId: invocation.input.tableId,
            trigger: triggerManifest,
            workflowId: invocation.input.workflowId
          };
          const command = buildCommandEnvelope("workflow.create", "workflow", invocation.input, {
            definition: {
              actions: draftedActionBindings,
              conditions: proposal.conditions,
              metadata: proposalMetadata,
              principal: {
                policyRevision: invocation.input.permissionsVersion,
                principalId: invocation.input.actor.principalId,
                schemaEpoch: invocation.input.schemaEpoch,
                scopeHash: invocation.input.permissionScopeHash
              },
              trigger: {
                match: {
                  fieldIds: triggerFieldIds ?? [],
                  tableId: invocation.input.tableId
                },
                operatorId: invocation.input.triggerId
              },
              workflowId: invocation.input.workflowId
            },
            name: invocation.input.name,
            tableId: invocation.input.tableId,
            workflowId: invocation.input.workflowId,
            workflowKey: invocation.input.workflowId.replace(/^wf_/, "").replaceAll("_", "-")
          });

          return {
            kind: "workflow-proposal",
            command,
            proposal,
            diffs: [
              {
                action: "propose",
                after: proposal,
                note: `Uses ${actions.length} workflow action operator(s).`,
                path: `/workflows/${invocation.input.workflowId}`
              }
            ],
            diagnostics
          };
        }
        case "updateWorkflow": {
          const command = buildCommandEnvelope("workflow.update", "workflow", invocation.input, {
            definition: invocation.input.definition,
            name: invocation.input.name,
            tableId: invocation.input.tableId,
            workflowId: invocation.input.workflowId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "publishWorkflow": {
          const command = buildCommandEnvelope("workflow.publish", "workflow", invocation.input, {
            workflowId: invocation.input.workflowId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "pauseWorkflow": {
          const command = buildCommandEnvelope("workflow.pause", "workflow", invocation.input, {
            workflowId: invocation.input.workflowId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "runWorkflow": {
          const command = buildCommandEnvelope("workflow.manual", "workflow", invocation.input, {
            input: invocation.input.input ?? {},
            ...(invocation.input.manualInvocationId
              ? { manualInvocationId: invocation.input.manualInvocationId }
              : {}),
            workflowId: invocation.input.workflowId
          });

          return {
            kind: "command-draft",
            command,
            diffs: summarizeCommand(command)
          };
        }
        case "dryRunCommand": {
          const result = await commandBus.dryRun(invocation.input.command);
          return {
            kind: "command-dry-run",
            command: invocation.input.command,
            diffs: summarizeCommand(invocation.input.command),
            result
          };
        }
        case "executeCommand": {
          const result = await commandBus.execute(invocation.input.command);
          return {
            kind: "command-execution",
            command: invocation.input.command,
            result
          };
        }
      }
    },
    listAccessible(fields, snapshot) {
      return permissionEngine.filterAgentTools(tools, fields, snapshot);
    },
    sanitizeInput(toolId, payload, fields, snapshot) {
      const tool = this.require(toolId);
      if (
        toolId === "explainPermissions" ||
        toolId === "previewPermissionPersona" ||
        toolId === "previewWorkflowTest"
      ) {
        return {
          diagnostics: [],
          hiddenFieldIds: [],
          sanitized: payload
        };
      }
      return sanitizePayload(permissionEngine, tool, payload, fields, snapshot);
    },
    sanitizeOutput(toolId, payload, fields, snapshot) {
      const tool = this.require(toolId);
      if (
        toolId === "explainPermissions" ||
        toolId === "previewPermissionPersona" ||
        toolId === "previewWorkflowTest"
      ) {
        return {
          diagnostics: [],
          hiddenFieldIds: [],
          sanitized: payload
        };
      }
      return sanitizePayload(permissionEngine, tool, payload, fields, snapshot);
    }
  };
}

function buildCommandEnvelope(
  commandType: string,
  scope: CommandEnvelope["scope"],
  input: {
    actor: CommandEnvelope["actor"];
    commandId?: string;
    idempotencyKey?: string;
    permissionScopeHash?: string;
    permissionsVersion?: number;
    schemaEpoch?: number;
    tableId?: string;
    workspaceId: string;
  },
  payload: Record<string, unknown>
): CommandEnvelope {
  const commandIdentitySuffix = crypto.randomUUID();

  return {
    actor: input.actor,
    commandId:
      input.commandId ?? `cmd_${commandType.replaceAll(".", "_")}_${commandIdentitySuffix}`,
    commandType,
    idempotencyKey:
      input.idempotencyKey ??
      `idem_${commandType.replaceAll(".", "_")}_${commandIdentitySuffix}`,
    payload,
    permissionScopeHash: input.permissionScopeHash,
    permissionsVersion: input.permissionsVersion,
    schemaEpoch: input.schemaEpoch,
    scope,
    tableId: input.tableId,
    workspaceId: input.workspaceId
  };
}

function summarizeCommand(command: CommandEnvelope): AgentToolAuditDiff[] {
  const payload = command.payload as Record<string, unknown>;

  switch (command.commandType) {
    case "table.create":
      return [
        {
          action: "create",
          after: {
            name: payload.tableName,
            tableId: payload.tableId
          },
          path: `/apps/${payload.appId}/tables/${payload.tableId}`
        },
        {
          action: "create",
          after: payload.primaryField,
          path: `/tables/${payload.tableId}/fields/${(payload.primaryField as Record<string, unknown>).fieldId}`
        }
      ];
    case "field.create":
      return [
        {
          action: "create",
          after: payload,
          path: `/tables/${payload.tableId}/fields/${payload.fieldId}`
        }
      ];
    case "view.create":
    case "view.update":
    case "view.delete":
      return [
        {
          action:
            command.commandType === "view.create"
              ? "create"
              : command.commandType === "view.delete"
                ? "delete"
                : "update",
          after: payload,
          path: `/tables/${payload.tableId}/views/${payload.viewId}`
        }
      ];
    case "field.permission.configure":
      return [
        {
          action: "update",
          after: payload,
          path: `/tables/${payload.tableId}/fields/${payload.fieldId}/permissions/${payload.principalId}`
        }
      ];
    case "field.update":
    case "field.archive":
    case "field.reorder":
      return [
        {
          action: "update",
          after: payload,
          path:
            command.commandType === "field.reorder"
              ? `/tables/${payload.tableId}/fields`
              : `/tables/${payload.tableId}/fields/${payload.fieldId}`
        }
      ];
    case "record.create":
      return [
        {
          action: "create",
          after: payload,
          path: `/tables/${command.tableId}/records/${payload.recordId}`
        }
      ];
    case "record.update":
    case "record.archive":
      return [
        {
          action: "update",
          after: payload,
          path: `/tables/${command.tableId}/records/${payload.recordId}`
        }
      ];
    case "records.bulk_patch": {
      const updates = Array.isArray(payload.updates)
        ? payload.updates.filter(
            (entry): entry is Record<string, unknown> =>
              typeof entry === "object" && entry !== null && !Array.isArray(entry)
          )
        : [];
      return updates.map((entry) => ({
        action: "update" as const,
        after: entry,
        path: `/tables/${command.tableId}/records/${entry.recordId}`
      }));
    }
    case "cell.set":
      return [
        {
          action: "update",
          after: payload,
          path: `/tables/${command.tableId}/records/${payload.recordId}/fields/${payload.fieldId}`
        }
      ];
    case "workflow.create":
      return [
        {
          action: "create",
          after: payload,
          path: `/workflows/${payload.workflowId}`
        }
      ];
    case "workflow.update":
    case "workflow.publish":
    case "workflow.pause":
      return [
        {
          action: "update",
          after: payload,
          path: `/workflows/${payload.workflowId}`
        }
      ];
    case "workflow.manual":
      return [
        {
          action: "create",
          after: payload,
          path: `/workflows/${payload.workflowId}/runs/manual`
        }
      ];
    default:
      return [
        {
          action: "propose",
          after: payload,
          path: `/commands/${command.commandType}`
        }
      ];
  }
}

function toWorkflowActionProposal(action: WorkflowActionDefinition): WorkflowActionManifest {
  return serializeWorkflowOperatorManifest(action) as WorkflowActionManifest;
}

function cloneWorkflowActionManifest(
  action: WorkflowActionDefinition,
  proposalTemplate: Record<string, unknown>
): WorkflowActionManifest {
  return {
    ...(serializeWorkflowOperatorManifest(action) as WorkflowActionManifest),
    proposalTemplate: cloneWorkflowActionInput(proposalTemplate)
  };
}

function cloneWorkflowActionInput(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function mergeWorkflowDefinitionMetadata(
  entries: readonly WorkflowDefinitionMetadata[]
): WorkflowDefinitionMetadata {
  const merged: WorkflowDefinitionMetadata = {};
  for (const entry of entries) {
    Object.assign(merged, entry);
  }

  const aggregateDefinitions = entries.flatMap((entry) => entry.aggregateDefinitions ?? []);
  if (aggregateDefinitions.length > 0) {
    merged.aggregateDefinitions = aggregateDefinitions;
  }

  const lookupDefinitions = entries.flatMap((entry) => entry.lookupDefinitions ?? []);
  if (lookupDefinitions.length > 0) {
    merged.lookupDefinitions = lookupDefinitions;
  }

  const relatedTableResolvers = entries.flatMap((entry) => entry.relatedTableResolvers ?? []);
  if (relatedTableResolvers.length > 0) {
    merged.relatedTableResolvers = relatedTableResolvers;
  }

  const lookupFieldIds = entries.flatMap((entry) => entry.lookupFieldIds ?? []);
  if (lookupFieldIds.length > 0) {
    merged.lookupFieldIds = Array.from(new Set(lookupFieldIds));
  }

  const rollupFieldIds = entries.flatMap((entry) => entry.rollupFieldIds ?? []);
  if (rollupFieldIds.length > 0) {
    merged.rollupFieldIds = Array.from(new Set(rollupFieldIds));
  }

  return merged;
}

function readWorkflowAuthoringMetadata(value: unknown): WorkflowAuthoringMetadata {
  return normalizeWorkflowAuthoringMetadata(value);
}

function toWorkflowTriggerProposal(trigger: WorkflowTriggerDefinition): WorkflowTriggerManifest {
  return serializeWorkflowOperatorManifest(trigger) as WorkflowTriggerManifest;
}

function sanitizePayload(
  permissionEngine: PermissionEngine,
  tool: AgentToolDefinition,
  payload: Record<string, unknown>,
  fields: readonly PermissionFieldDescriptor[],
  snapshot?: EffectivePermissionSnapshot
): AgentToolSanitizationResult {
  const visibility = permissionEngine.resolveAgentToolFieldVisibility(fields, snapshot);
  const inaccessibleFieldIds = new Set(visibility.hiddenFieldIds);
  const diagnostics = new Set<string>();
  const removedFieldIds = new Set<string>();
  const nonWritableFieldIds = new Set<string>();

  if (tool.mutating && tool.mutationTarget === "records") {
    const writableFieldIds = new Set(visibility.writableFieldIds);
    for (const field of fields) {
      if (!writableFieldIds.has(field.fieldId)) {
        inaccessibleFieldIds.add(field.fieldId);
        if (!visibility.hiddenFieldIds.includes(field.fieldId)) {
          nonWritableFieldIds.add(field.fieldId);
        }
      }
    }
  }

  const sanitized = sanitizeUnknown(payload, inaccessibleFieldIds, removedFieldIds);

  for (const fieldId of removedFieldIds) {
    diagnostics.add(
      nonWritableFieldIds.has(fieldId) ? `agent_non_writable:${fieldId}` : `agent_hidden:${fieldId}`
    );
  }

  return {
    diagnostics: [...diagnostics],
    hiddenFieldIds: [...removedFieldIds],
    sanitized: isRecord(sanitized) ? sanitized : {}
  };
}

function sanitizeUnknown(
  value: unknown,
  inaccessibleFieldIds: ReadonlySet<string>,
  removedFieldIds: Set<string>
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeUnknown(entry, inaccessibleFieldIds, removedFieldIds))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.fieldId === "string" && inaccessibleFieldIds.has(value.fieldId)) {
    removedFieldIds.add(value.fieldId);
    return undefined;
  }

  const sanitizedEntries: Array<[string, unknown]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (singularFieldIdKeys.has(key) && typeof entry === "string") {
      if (inaccessibleFieldIds.has(entry)) {
        removedFieldIds.add(entry);
        continue;
      }

      sanitizedEntries.push([key, entry]);
      continue;
    }

    if (fieldIdArrayKeys.has(key) && Array.isArray(entry)) {
      const visibleFieldIds = entry.filter((item): item is string => {
        if (typeof item !== "string") {
          return false;
        }

        if (inaccessibleFieldIds.has(item)) {
          removedFieldIds.add(item);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, visibleFieldIds]);
      continue;
    }

    if (key === "fields" && isRecord(entry)) {
      const visibleEntries = Object.entries(entry).filter(([fieldId]) => {
        if (inaccessibleFieldIds.has(fieldId)) {
          removedFieldIds.add(fieldId);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, Object.fromEntries(visibleEntries)]);
      continue;
    }

    if (key === "cells" && isRecord(entry)) {
      const visibleEntries = Object.entries(entry).filter(([fieldId]) => {
        if (inaccessibleFieldIds.has(fieldId)) {
          removedFieldIds.add(fieldId);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, Object.fromEntries(visibleEntries)]);
      continue;
    }

    if (key === "patch" && isRecord(entry)) {
      const visibleEntries = Object.entries(entry).filter(([fieldId]) => {
        if (inaccessibleFieldIds.has(fieldId)) {
          removedFieldIds.add(fieldId);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, Object.fromEntries(visibleEntries)]);
      continue;
    }

    const sanitizedEntry = sanitizeUnknown(entry, inaccessibleFieldIds, removedFieldIds);
    if (sanitizedEntry !== undefined) {
      sanitizedEntries.push([key, sanitizedEntry]);
    }
  }

  return Object.fromEntries(sanitizedEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ResolvedReactiveRollupProposal = {
  actionProposals: WorkflowActionManifest[];
  actions: Array<{
    input: Record<string, unknown>;
    operatorId: string;
  }>;
  metadata: WorkflowDefinitionMetadata | null;
  triggerFieldIds: string[];
};

type ParsedProposalField = {
  config: unknown;
  fieldId: string;
  fieldKey: string;
  fieldType: string;
};

type ResolvedCrossTableSyncProposal = {
  actionProposal: WorkflowActionManifest | null;
  action: {
    input: Record<string, unknown>;
    operatorId: string;
  } | null;
  metadata: WorkflowDefinitionMetadata | null;
  triggerFieldIds: string[];
};

async function buildReactiveRollupProposalTemplate(input: {
  diagnostics: string[];
  rollupFieldIds: readonly string[];
  setCellAction: WorkflowActionDefinition | null;
  sourceTableId: string;
  tableSchemaInspector: TableSchemaInspector;
  workspaceId: string;
  workspaceInspector: WorkspaceInspector;
}): Promise<ResolvedReactiveRollupProposal> {
  if (input.rollupFieldIds.length === 0) {
    return {
      actionProposals: [],
      actions: [],
      metadata: null,
      triggerFieldIds: []
    };
  }

  const workspace = await Promise.resolve(
    input.workspaceInspector.inspect({
      include: ["tables"],
      workspaceId: input.workspaceId
    })
  );
  const tableIdByFieldId = new Map<string, string>();
  for (const table of workspace.tables) {
    for (const fieldId of table.fieldIds) {
      tableIdByFieldId.set(fieldId, table.tableId);
    }
  }

  if (input.setCellAction === null) {
    input.diagnostics.push("missing_rollup_set_cell_action");
    return {
      actionProposals: [],
      actions: [],
      metadata: null,
      triggerFieldIds: []
    };
  }

  const relatedTableResolvers: WorkflowRelatedTableResolver[] = [];
  const aggregateDefinitions: WorkflowAggregateDefinition[] = [];
  const actionBindings: Array<{
    input: Record<string, unknown>;
    operatorId: string;
  }> = [];
  const actionProposals: WorkflowActionManifest[] = [];
  const triggerFieldIds = new Set<string>();

  for (const rollupFieldId of input.rollupFieldIds) {
    const owningTableId = tableIdByFieldId.get(rollupFieldId);
    if (!owningTableId) {
      input.diagnostics.push(`unknown_rollup_field:${rollupFieldId}`);
      continue;
    }

    const schema = await Promise.resolve(
      input.tableSchemaInspector.read({
        tableId: owningTableId,
        workspaceId: input.workspaceId
      })
    );
    const parsedSchema = parseTableSchemaForProposal(schema);
    const field = parsedSchema.fields.find((entry) => entry.fieldId === rollupFieldId);
    if (!field) {
      input.diagnostics.push(`unknown_rollup_field:${rollupFieldId}`);
      continue;
    }
    if (field.fieldType !== "computed.readonly") {
      input.diagnostics.push(`rollup_field_type_invalid:${rollupFieldId}:${field.fieldType}`);
      continue;
    }

    const rollup = readComputedFieldConfig(field.config)?.rollup;
    if (!rollup) {
      input.diagnostics.push(`rollup_field_config_missing:${rollupFieldId}`);
      continue;
    }
    if (rollup.sourceTableId !== input.sourceTableId) {
      input.diagnostics.push(
        `rollup_field_source_table_mismatch:${rollupFieldId}:${rollup.sourceTableId}:${input.sourceTableId}`
      );
      continue;
    }

    const resolverAlias = `rollup_${rollupFieldId}`;
    const resolver =
      rollup.grouping.strategy === "value_match"
        ? ({
            alias: resolverAlias,
            sourceFieldId: rollup.grouping.sourceFieldId,
            strategy: "value_match",
            targetFieldId: rollup.grouping.targetFieldId,
            targetTableId: parsedSchema.tableId
          } satisfies WorkflowRelatedTableResolver)
        : ({
            alias: resolverAlias,
            sourceFieldId: rollup.grouping.sourceFieldId,
            strategy: "single_relation",
            targetTableId: parsedSchema.tableId
          } satisfies WorkflowRelatedTableResolver);
    relatedTableResolvers.push(resolver);
    triggerFieldIds.add(rollup.grouping.sourceFieldId);
    if (rollup.operandFieldId) {
      triggerFieldIds.add(rollup.operandFieldId);
    }
    const extraDependencyFieldIds = readDependencyFieldIds(field.config).filter(
      (dependencyFieldId) =>
        dependencyFieldId !== rollup.grouping.sourceFieldId &&
        dependencyFieldId !== rollup.operandFieldId
    );
    for (const dependencyFieldId of extraDependencyFieldIds) {
      triggerFieldIds.add(dependencyFieldId);
    }

    aggregateDefinitions.push({
      alias: rollupFieldId,
      ...(extraDependencyFieldIds.length > 0
        ? {
            dependencyFieldIds: extraDependencyFieldIds
          }
        : {}),
      groupingSource: {
        kind: "related_record",
        resolverAlias
      },
      ...(rollup.operandFieldId
        ? {
            operand: {
              fieldId: rollup.operandFieldId,
              kind: "source_field" as const,
              valueType: "number" as const
            }
          }
        : {}),
      ...(rollup.operationConfig ? { operationConfig: rollup.operationConfig } : {}),
      operationId: rollup.operationId,
      sourceRelationPath: `relatedTables.${resolverAlias}`,
      targetFieldId: rollupFieldId
    });

    const actionInput = {
      fieldId: {
        path: `relatedTables.${resolverAlias}.row.fields.${field.fieldKey}.fieldId`
      },
      fieldType: {
        path: `relatedTables.${resolverAlias}.row.fields.${field.fieldKey}.fieldType`
      },
      recordId: {
        path: `relatedTables.${resolverAlias}.row.recordId`
      },
      tableId: {
        path: `relatedTables.${resolverAlias}.tableId`
      },
      value: {
        path: "cell.value"
      }
    };
    actionBindings.push({
      input: actionInput,
      operatorId: "set_cell"
    });
    actionProposals.push(cloneWorkflowActionManifest(input.setCellAction, actionInput));
  }

  if (aggregateDefinitions.length === 0 || relatedTableResolvers.length === 0) {
    return {
      actionProposals,
      actions: actionBindings,
      metadata: null,
      triggerFieldIds: [...triggerFieldIds]
    };
  }

  return {
    actionProposals,
    actions: actionBindings,
    metadata: {
      aggregateDefinitions,
      relatedTableResolvers,
      rollupFieldIds: [...input.rollupFieldIds]
    },
    triggerFieldIds: [...triggerFieldIds]
  };
}

function parseTableSchemaForProposal(value: unknown): {
  fields: ParsedProposalField[];
  tableId: string;
} {
  if (!isRecord(value) || typeof value.tableId !== "string" || !Array.isArray(value.fields)) {
    return {
      fields: [],
      tableId: ""
    };
  }

  return {
    fields: value.fields.flatMap((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.fieldId !== "string" ||
        typeof entry.fieldKey !== "string" ||
        typeof entry.fieldType !== "string"
      ) {
        return [];
      }

      return [
        {
          config: entry.config,
          fieldId: entry.fieldId,
          fieldKey: entry.fieldKey,
          fieldType: entry.fieldType
        }
      ];
    }),
    tableId: value.tableId
  };
}

function readDependencyFieldIds(config: unknown): string[] {
  if (!isRecord(config) || !Array.isArray(config.dependsOnFieldIds)) {
    return [];
  }

  return config.dependsOnFieldIds.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
}

async function buildCrossTableSyncProposalTemplate(input: {
  diagnostics: string[];
  relatedSourceFieldId?: string;
  relatedTargetFieldId?: string;
  sourceTableId: string;
  syncRelatedFieldAction: WorkflowActionDefinition | null;
  syncSourceFieldId?: string;
  syncTargetFieldId?: string;
  tableSchemaInspector: TableSchemaInspector;
  workspaceId: string;
  workspaceInspector: WorkspaceInspector;
}): Promise<ResolvedCrossTableSyncProposal> {
  const hasAnySyncInput =
    input.syncSourceFieldId !== undefined ||
    input.syncTargetFieldId !== undefined ||
    input.relatedSourceFieldId !== undefined ||
    input.relatedTargetFieldId !== undefined;
  if (!hasAnySyncInput) {
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  if (!input.syncSourceFieldId || !input.syncTargetFieldId || !input.relatedSourceFieldId) {
    if (!input.syncSourceFieldId) {
      input.diagnostics.push("workflow_sync_authoring_source_field_missing");
    }
    if (!input.syncTargetFieldId) {
      input.diagnostics.push("workflow_sync_authoring_target_field_missing");
    }
    if (!input.relatedSourceFieldId) {
      input.diagnostics.push("workflow_sync_authoring_related_source_field_missing");
    }
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  if (input.syncRelatedFieldAction === null) {
    input.diagnostics.push("missing_sync_related_field_action");
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  const workspace = await Promise.resolve(
    input.workspaceInspector.inspect({
      include: ["tables"],
      workspaceId: input.workspaceId
    })
  );
  const tableIdByFieldId = new Map<string, string>();
  for (const table of workspace.tables) {
    for (const fieldId of table.fieldIds) {
      tableIdByFieldId.set(fieldId, table.tableId);
    }
  }

  const sourceSchema = parseTableSchemaForProposal(
    await Promise.resolve(
      input.tableSchemaInspector.read({
        tableId: input.sourceTableId,
        workspaceId: input.workspaceId
      })
    )
  );
  const sourceField = sourceSchema.fields.find(
    (field) => field.fieldId === input.syncSourceFieldId
  );
  if (!sourceField) {
    input.diagnostics.push(`workflow_sync_authoring_source_field_missing:${input.syncSourceFieldId}`);
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  const relatedSourceField = sourceSchema.fields.find(
    (field) => field.fieldId === input.relatedSourceFieldId
  );
  if (!relatedSourceField) {
    input.diagnostics.push(
      `workflow_sync_authoring_related_source_field_missing:${input.relatedSourceFieldId}`
    );
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  const targetTableId = resolveSyncTargetTableId({
    diagnostics: input.diagnostics,
    relatedSourceField,
    relatedTargetFieldId: input.relatedTargetFieldId,
    tableIdByFieldId
  });
  if (!targetTableId) {
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  const targetSchema = parseTableSchemaForProposal(
    await Promise.resolve(
      input.tableSchemaInspector.read({
        tableId: targetTableId,
        workspaceId: input.workspaceId
      })
    )
  );
  const targetField = targetSchema.fields.find(
    (field) => field.fieldId === input.syncTargetFieldId
  );
  if (!targetField) {
    input.diagnostics.push(`workflow_sync_authoring_target_field_missing:${input.syncTargetFieldId}`);
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  let resolver: WorkflowRelatedTableResolver;
  if (input.relatedTargetFieldId) {
    const relatedTargetTableId = tableIdByFieldId.get(input.relatedTargetFieldId);
    if (!relatedTargetTableId) {
      input.diagnostics.push(
        `workflow_sync_authoring_related_target_field_missing:${input.relatedTargetFieldId}`
      );
      return {
        action: null,
        actionProposal: null,
        metadata: null,
        triggerFieldIds: []
      };
    }
    if (relatedTargetTableId !== targetTableId) {
      input.diagnostics.push(
        `workflow_sync_authoring_related_target_table_mismatch:${input.relatedTargetFieldId}:${relatedTargetTableId}:${targetTableId}`
      );
      return {
        action: null,
        actionProposal: null,
        metadata: null,
        triggerFieldIds: []
      };
    }

    const relatedTargetField = targetSchema.fields.find(
      (field) => field.fieldId === input.relatedTargetFieldId
    );
    if (!relatedTargetField) {
      input.diagnostics.push(
        `workflow_sync_authoring_related_target_field_missing:${input.relatedTargetFieldId}`
      );
      return {
        action: null,
        actionProposal: null,
        metadata: null,
        triggerFieldIds: []
      };
    }
    if (relatedSourceField.fieldType !== relatedTargetField.fieldType) {
      input.diagnostics.push(
        `workflow_sync_authoring_related_field_type_mismatch:${relatedSourceField.fieldType}:${relatedTargetField.fieldType}`
      );
      return {
        action: null,
        actionProposal: null,
        metadata: null,
        triggerFieldIds: []
      };
    }
    resolver = {
      alias: `sync_${input.syncTargetFieldId}`,
      sourceFieldId: input.relatedSourceFieldId,
      strategy: "value_match",
      targetFieldId: input.relatedTargetFieldId,
      targetTableId
    };
  } else {
    if (relatedSourceField.fieldType !== "relation.record") {
      input.diagnostics.push(
        `workflow_sync_authoring_relationship_missing:${input.relatedSourceFieldId}`
      );
      return {
        action: null,
        actionProposal: null,
        metadata: null,
        triggerFieldIds: []
      };
    }
    resolver = {
      alias: `sync_${input.syncTargetFieldId}`,
      sourceFieldId: input.relatedSourceFieldId,
      strategy: "single_relation",
      targetTableId
    };
  }

  if (targetTableId === input.sourceTableId) {
    input.diagnostics.push(`workflow_sync_authoring_requires_cross_table_target:${targetTableId}`);
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  if (!isSupportedWorkflowSyncProposalFieldType(sourceField.fieldType)) {
    input.diagnostics.push(
      `workflow_sync_authoring_source_field_type_invalid:${sourceField.fieldType}`
    );
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }
  if (!isSupportedWorkflowSyncProposalFieldType(targetField.fieldType)) {
    input.diagnostics.push(
      `workflow_sync_authoring_target_field_type_invalid:${targetField.fieldType}`
    );
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }
  if (sourceField.fieldType !== targetField.fieldType) {
    input.diagnostics.push(
      `workflow_sync_authoring_field_type_mismatch:${sourceField.fieldType}:${targetField.fieldType}`
    );
    return {
      action: null,
      actionProposal: null,
      metadata: null,
      triggerFieldIds: []
    };
  }

  const actionInput = {
    resolverAlias: resolver.alias,
    sourceFieldId: input.syncSourceFieldId,
    targetFieldId: input.syncTargetFieldId
  };

  return {
    action: {
      input: actionInput,
      operatorId: "sync_related_field"
    },
    actionProposal: cloneWorkflowActionManifest(input.syncRelatedFieldAction, actionInput),
    metadata: {
      relatedTableResolvers: [resolver]
    },
    triggerFieldIds: [
      input.syncSourceFieldId,
      ...(input.relatedSourceFieldId === input.syncSourceFieldId ? [] : [input.relatedSourceFieldId])
    ]
  };
}

function resolveSyncTargetTableId(input: {
  diagnostics: string[];
  relatedSourceField: ParsedProposalField;
  relatedTargetFieldId?: string;
  tableIdByFieldId: ReadonlyMap<string, string>;
}): string | null {
  if (input.relatedTargetFieldId) {
    const config = isRecord(input.relatedSourceField.config) ? input.relatedSourceField.config : null;
    if (input.relatedSourceField.fieldType === "relation.record" && config?.allowMultiple === false) {
      input.diagnostics.push(
        `workflow_sync_authoring_strategy_ambiguous:${input.relatedSourceField.fieldId}:${input.relatedTargetFieldId}`
      );
      return null;
    }

    const targetTableId = input.tableIdByFieldId.get(input.relatedTargetFieldId);
    if (!targetTableId) {
      input.diagnostics.push(
        `workflow_sync_authoring_related_target_field_missing:${input.relatedTargetFieldId}`
      );
      return null;
    }

    return targetTableId;
  }

  if (input.relatedSourceField.fieldType !== "relation.record") {
    input.diagnostics.push(
      `workflow_sync_authoring_relationship_missing:${input.relatedSourceField.fieldId}`
    );
    return null;
  }

  const config = isRecord(input.relatedSourceField.config) ? input.relatedSourceField.config : null;
  if (config?.allowMultiple !== false || typeof config?.targetTableId !== "string") {
    input.diagnostics.push(
      `workflow_sync_authoring_relationship_missing:${input.relatedSourceField.fieldId}`
    );
    return null;
  }

  return config.targetTableId;
}

function isSupportedWorkflowSyncProposalFieldType(fieldType: string): boolean {
  return fieldType !== "computed.readonly" && fieldType !== "relation.record";
}
