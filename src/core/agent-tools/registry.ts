import type { CommandBus } from "../commands/command-bus";
import type { CommandEnvelope } from "../commands/types";
import type {
  EffectivePermissionSnapshot,
  PermissionEngine,
  PermissionFieldDescriptor
} from "../permissions/types";
import type { ViewPlanner } from "../views/planner";
import type { WorkflowActionDefinition, WorkflowOperatorRegistry } from "../workflows/types";
import type {
  AgentToolAuditDiff,
  AgentToolDefinition,
  AgentToolId,
  AgentToolInvocation,
  AgentToolInvocationResult,
  AgentToolRegistry,
  AgentToolSanitizationResult,
  WorkflowHistoryReader,
  WorkflowRunReader,
  WorkspaceInspector
} from "./types";

type CreateAgentToolRegistryDeps = {
  permissionEngine: PermissionEngine;
  commandBus: CommandBus;
  viewPlanner: ViewPlanner;
  workflowOperatorRegistry: WorkflowOperatorRegistry;
  workflowHistoryReader: WorkflowHistoryReader;
  workflowRunReader: WorkflowRunReader;
  workspaceInspector: WorkspaceInspector;
};

const jsonBooleanSchema = {
  type: "boolean"
} as const;

const jsonStringSchema = {
  type: "string"
} as const;

const jsonFieldRefSchema = {
  properties: {
    fieldId: jsonStringSchema
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
        name: jsonStringSchema,
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
  workflowOperatorRegistry,
  workflowHistoryReader,
  workflowRunReader,
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
        case "proposeWorkflow": {
          const diagnostics: string[] = [];
          const trigger = workflowOperatorRegistry.get(invocation.input.triggerId);
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

          const proposal = {
            actions: actions.map(toWorkflowActionProposal),
            businessRule: invocation.input.businessRule,
            name: invocation.input.name,
            tableId: invocation.input.tableId,
            trigger: {
              id: trigger?.id ?? invocation.input.triggerId,
              kind: "trigger" as const
            },
            workflowId: invocation.input.workflowId
          };
          const command = buildCommandEnvelope("workflow.create", "workflow", invocation.input, {
            definition: {
              actions: actions.map((action) => ({
                input: {},
                operatorId: action.id
              })),
              conditions: [],
              metadata: {
                businessRule: invocation.input.businessRule,
                name: invocation.input.name,
                status: "draft",
                tableId: invocation.input.tableId
              },
              principal: {
                policyRevision: invocation.input.permissionsVersion,
                principalId: invocation.input.actor.principalId,
                schemaEpoch: invocation.input.schemaEpoch,
                scopeHash: invocation.input.permissionScopeHash
              },
              trigger: {
                match: {
                  fieldIds: invocation.input.fieldIds ?? [],
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
      this.require(toolId);
      return sanitizePayload(permissionEngine, payload, fields, snapshot);
    },
    sanitizeOutput(toolId, payload, fields, snapshot) {
      this.require(toolId);
      return sanitizePayload(permissionEngine, payload, fields, snapshot);
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
      return [
        {
          action: command.commandType === "view.create" ? "create" : "update",
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
    case "workflow.create":
      return [
        {
          action: "create",
          after: payload,
          path: `/workflows/${payload.workflowId}`
        }
      ];
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

function toWorkflowActionProposal(action: WorkflowActionDefinition) {
  return {
    commandType: action.commandType,
    id: action.id,
    requiredCapabilities: action.requiredCapabilities
  };
}

function sanitizePayload(
  permissionEngine: PermissionEngine,
  payload: Record<string, unknown>,
  fields: readonly PermissionFieldDescriptor[],
  snapshot?: EffectivePermissionSnapshot
): AgentToolSanitizationResult {
  const visibility = permissionEngine.resolveAgentToolFieldVisibility(fields, snapshot);
  const hiddenFieldIds = new Set(visibility.hiddenFieldIds);
  const diagnostics = new Set<string>();
  const removedFieldIds = new Set<string>();

  const sanitized = sanitizeUnknown(payload, hiddenFieldIds, removedFieldIds);

  for (const fieldId of removedFieldIds) {
    diagnostics.add(`agent_hidden:${fieldId}`);
  }

  return {
    diagnostics: [...diagnostics],
    hiddenFieldIds: [...removedFieldIds],
    sanitized: isRecord(sanitized) ? sanitized : {}
  };
}

function sanitizeUnknown(
  value: unknown,
  hiddenFieldIds: ReadonlySet<string>,
  removedFieldIds: Set<string>
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeUnknown(entry, hiddenFieldIds, removedFieldIds))
      .filter((entry) => entry !== undefined);
  }

  if (!isRecord(value)) {
    return value;
  }

  if (typeof value.fieldId === "string" && hiddenFieldIds.has(value.fieldId)) {
    removedFieldIds.add(value.fieldId);
    return undefined;
  }

  const sanitizedEntries: Array<[string, unknown]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (singularFieldIdKeys.has(key) && typeof entry === "string") {
      if (hiddenFieldIds.has(entry)) {
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

        if (hiddenFieldIds.has(item)) {
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
        if (hiddenFieldIds.has(fieldId)) {
          removedFieldIds.add(fieldId);
          return false;
        }

        return true;
      });
      sanitizedEntries.push([key, Object.fromEntries(visibleEntries)]);
      continue;
    }

    const sanitizedEntry = sanitizeUnknown(entry, hiddenFieldIds, removedFieldIds);
    if (sanitizedEntry !== undefined) {
      sanitizedEntries.push([key, sanitizedEntry]);
    }
  }

  return Object.fromEntries(sanitizedEntries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
