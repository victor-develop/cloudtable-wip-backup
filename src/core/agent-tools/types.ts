import type { JsonSchema } from "../field-types/types";
import type { CommandActor, CommandEnvelope, CommandResult, CommandScope } from "../commands/types";
import type { WorkflowOperatorCapability, WorkflowOperatorKind } from "../workflows/types";

export type AgentToolScope = "app" | "table" | "view" | "workflow";
export type AgentToolPhase = "draft" | "preview" | "execute";
export type AgentToolMutationTarget =
  | "none"
  | "records"
  | "schema"
  | "view"
  | "workflow"
  | "permissions"
  | "command";
export type AgentToolFieldBinding =
  | "none"
  | "all-visible-fields"
  | "explicit-field-ids";

export type AgentToolId =
  | "inspectWorkspace"
  | "readWorkflowHistory"
  | "readWorkflowRunDetail"
  | "createTable"
  | "createField"
  | "createView"
  | "updateView"
  | "configureFieldPermission"
  | "proposeWorkflow"
  | "publishWorkflow"
  | "pauseWorkflow"
  | "runWorkflow"
  | "dryRunCommand"
  | "executeCommand";

export type AgentToolBinding =
  | {
      kind: "query-service";
      service: "workspaceInspector" | "workflowHistoryReader" | "workflowRunReader";
    }
  | {
      kind: "command-builder";
      commandType: string;
      scope: CommandScope;
    }
  | {
      kind: "proposal-service";
      service: "workflowOperatorRegistry";
    }
  | {
      kind: "command-bus";
      operation: "dry-run" | "execute";
    };

export type AgentToolDefinition = {
  id: AgentToolId;
  description: string;
  binding: AgentToolBinding;
  fieldBinding: AgentToolFieldBinding;
  fieldIds?: readonly string[];
  inputSchema: JsonSchema;
  mutating: boolean;
  mutationTarget: AgentToolMutationTarget;
  outputSchema: JsonSchema;
  phase: AgentToolPhase;
  requiresConfirmation: boolean;
  scope: AgentToolScope;
  successorToolId?: AgentToolId;
};

export type AgentToolCommandBase = {
  actor: CommandActor;
  commandId?: string;
  idempotencyKey?: string;
  permissionScopeHash?: string;
  permissionsVersion?: number;
  schemaEpoch?: number;
  workspaceId: string;
};

export type CreateTableToolInput = AgentToolCommandBase & {
  appId: string;
  tableId: string;
  tableName: string;
  description?: string;
  primaryField: {
    fieldId: string;
    fieldType: string;
    name: string;
    required?: boolean;
  };
};

export type CreateFieldToolInput = AgentToolCommandBase & {
  tableId: string;
  fieldId: string;
  fieldType: string;
  name: string;
  required?: boolean;
  config?: Record<string, unknown>;
};

export type CreateViewToolInput = AgentToolCommandBase & {
  tableId: string;
  viewId: string;
  viewName: string;
  visibleFieldIds: string[];
  filterFieldIds?: string[];
  sortFieldIds?: string[];
  filters?: Array<{
    fieldId: string;
    operatorId: string;
    value?: unknown;
    comparator?: string;
  }>;
  sorts?: Array<{
    fieldId: string;
    mode?: string;
  }>;
  groupByFieldId?: string;
};

export type UpdateViewToolInput = AgentToolCommandBase & {
  tableId: string;
  viewId: string;
  viewName: string;
  visibleFieldIds: string[];
  filterFieldIds?: string[];
  sortFieldIds?: string[];
  filters?: Array<{
    fieldId: string;
    operatorId: string;
    value?: unknown;
    comparator?: string;
  }>;
  sorts?: Array<{
    fieldId: string;
    mode?: string;
  }>;
  groupByFieldId?: string;
};

export type ConfigureFieldPermissionToolInput = AgentToolCommandBase & {
  tableId: string;
  fieldId: string;
  principalId: string;
  read: "visible" | "redacted" | "hidden";
  write: boolean;
  workflow: boolean;
  agent: boolean;
};

export type InspectWorkspaceToolInput = {
  workspaceId: string;
  include?: Array<"apps" | "tables" | "views" | "workflows" | "catalog">;
};

export type ProposeWorkflowToolInput = AgentToolCommandBase & {
  workflowId: string;
  name: string;
  tableId: string;
  businessRule: string;
  fieldIds?: string[];
  triggerId: string;
  actionIds: string[];
};

export type PublishWorkflowToolInput = AgentToolCommandBase & {
  tableId: string;
  workflowId: string;
};

export type PauseWorkflowToolInput = AgentToolCommandBase & {
  tableId: string;
  workflowId: string;
};

export type RunWorkflowToolInput = AgentToolCommandBase & {
  tableId: string;
  workflowId: string;
  input?: Record<string, unknown>;
  manualInvocationId?: string;
};

export type DryRunCommandToolInput = {
  command: CommandEnvelope;
};

export type ExecuteCommandToolInput = {
  command: CommandEnvelope;
};

export type ReadWorkflowHistoryToolInput = {
  workflowId: string;
  workspaceId: string;
};

export type ReadWorkflowRunDetailToolInput = {
  workflowRunId: string;
  workspaceId: string;
};

export type WorkspaceInspection = {
  workspaceId: string;
  apps: Array<{
    appId: string;
    name: string;
    tableIds: string[];
  }>;
  tables: Array<{
    tableId: string;
    name: string;
    fieldIds: string[];
    viewIds: string[];
  }>;
  views: Array<{
    viewId: string;
    tableId: string;
    name: string;
  }>;
  workflows: Array<{
    workflowId: string;
    name: string;
    tableId: string;
    status: "draft" | "published" | "paused";
  }>;
  catalog?: {
    fieldTypes: string[];
    workflowOperators: Array<{
      id: string;
      kind: WorkflowOperatorKind;
      requiredCapabilities: readonly WorkflowOperatorCapability[];
    }>;
  };
};

export type WorkspaceInspector = {
  inspect(input: InspectWorkspaceToolInput): Promise<WorkspaceInspection> | WorkspaceInspection;
};

export type WorkflowHistoryReader = {
  read(
    input: ReadWorkflowHistoryToolInput
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WorkflowRunReader = {
  read(
    input: ReadWorkflowRunDetailToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type AgentToolAuditDiff = {
  action: "create" | "update" | "propose";
  after: unknown;
  before?: unknown;
  note?: string;
  path: string;
};

export type AgentToolWorkflowProposal = {
  workflowId: string;
  name: string;
  tableId: string;
  businessRule: string;
  trigger: {
    id: string;
    kind: "trigger";
  };
  actions: Array<{
    id: string;
    commandType?: string;
    requiredCapabilities: readonly WorkflowOperatorCapability[];
  }>;
};

export type AgentToolInvocation =
  | {
      toolId: "inspectWorkspace";
      input: InspectWorkspaceToolInput;
    }
  | {
      toolId: "readWorkflowHistory";
      input: ReadWorkflowHistoryToolInput;
    }
  | {
      toolId: "readWorkflowRunDetail";
      input: ReadWorkflowRunDetailToolInput;
    }
  | {
      toolId: "createTable";
      input: CreateTableToolInput;
    }
  | {
      toolId: "createField";
      input: CreateFieldToolInput;
    }
  | {
      toolId: "createView";
      input: CreateViewToolInput;
    }
  | {
      toolId: "updateView";
      input: UpdateViewToolInput;
    }
  | {
      toolId: "configureFieldPermission";
      input: ConfigureFieldPermissionToolInput;
    }
  | {
      toolId: "proposeWorkflow";
      input: ProposeWorkflowToolInput;
    }
  | {
      toolId: "publishWorkflow";
      input: PublishWorkflowToolInput;
    }
  | {
      toolId: "pauseWorkflow";
      input: PauseWorkflowToolInput;
    }
  | {
      toolId: "runWorkflow";
      input: RunWorkflowToolInput;
    }
  | {
      toolId: "dryRunCommand";
      input: DryRunCommandToolInput;
    }
  | {
      toolId: "executeCommand";
      input: ExecuteCommandToolInput;
    };

export type AgentToolInvocationResult =
  | {
      kind: "workspace-inspection";
      workspace: WorkspaceInspection;
    }
  | {
      kind: "workflow-history";
      history: Record<string, unknown>;
    }
  | {
      kind: "workflow-run-detail";
      run: Record<string, unknown> | null;
    }
  | {
      kind: "command-draft";
      command: CommandEnvelope;
      diffs: AgentToolAuditDiff[];
    }
  | {
      kind: "workflow-proposal";
      proposal: AgentToolWorkflowProposal;
      command: CommandEnvelope;
      diffs: AgentToolAuditDiff[];
      diagnostics: string[];
    }
  | {
      kind: "command-dry-run";
      command: CommandEnvelope;
      diffs: AgentToolAuditDiff[];
      result: CommandResult;
    }
  | {
      kind: "command-execution";
      command: CommandEnvelope;
      result: CommandResult;
    };

export type AgentToolAccessPlan = {
  allowed: boolean;
  hiddenFieldIds: string[];
  reason: string | null;
  toolId: string;
  visibleFieldIds: string[];
};

export type AgentToolSanitizationResult = {
  diagnostics: string[];
  hiddenFieldIds: string[];
  sanitized: Record<string, unknown>;
};

export type AgentToolRegistry = {
  list(): AgentToolDefinition[];
  get(toolId: AgentToolId): AgentToolDefinition | undefined;
  require(toolId: AgentToolId): AgentToolDefinition;
  invoke(invocation: AgentToolInvocation): Promise<AgentToolInvocationResult>;
  listAccessible(
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolAccessPlan[];
  sanitizeInput(
    toolId: AgentToolId,
    payload: Record<string, unknown>,
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolSanitizationResult;
  sanitizeOutput(
    toolId: AgentToolId,
    payload: Record<string, unknown>,
    fields: readonly {
      fieldId: string;
      fieldType: string;
    }[],
    snapshot?: import("../permissions/types").EffectivePermissionSnapshot
  ): AgentToolSanitizationResult;
};
