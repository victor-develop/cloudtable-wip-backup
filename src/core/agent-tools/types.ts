import type { AggregateOperationManifest } from "../aggregates/types";
import type { FieldTypeManifest, JsonSchema } from "../field-types/types";
import type { CommandActor, CommandEnvelope, CommandResult, CommandScope } from "../commands/types";
import type {
  ExplainablePermissionSurface,
  FieldPermissionExplanation
} from "../permissions/types";
import type {
  WorkflowActionManifest,
  WorkflowAuthoringMetadata,
  WorkflowDefinitionMetadata,
  WorkflowOperatorManifest,
  WorkflowTriggerManifest
} from "../workflows/types";
import type { ViewAuthoringMetadata } from "../views/authoring";

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
  | "inspectApp"
  | "inspectTableSchema"
  | "inspectViewDefinition"
  | "inspectWorkflowDefinition"
  | "previewWorkflowTest"
  | "explainPermissions"
  | "previewPermissionPersona"
  | "inspectRecord"
  | "queryView"
  | "readActivityHistory"
  | "readWorkspaceActivityHistory"
  | "readAppActivityHistory"
  | "readWorkflowHistory"
  | "readWorkflowDependencies"
  | "readWorkflowRunDetail"
  | "prepareWorkflowDeadLetterReplay"
  | "requestWorkflowDeadLetterReplay"
  | "prepareWorkflowAggregateMaintenance"
  | "requestWorkflowAggregateMaintenance"
  | "prepareWorkflowLookupMaintenance"
  | "requestWorkflowLookupMaintenance"
  | "prepareWorkflowSyncMaintenance"
  | "requestWorkflowSyncMaintenance"
  | "prepareWorkflowBackfillDisposition"
  | "requestWorkflowBackfillDisposition"
  | "createApp"
  | "createTable"
  | "createField"
  | "createView"
  | "updateView"
  | "deleteView"
  | "configureFieldPermission"
  | "updateField"
  | "archiveField"
  | "reorderFields"
  | "createRecord"
  | "updateRecord"
  | "bulkUpdateRecords"
  | "archiveRecord"
  | "updateCell"
  | "proposeWorkflow"
  | "updateWorkflow"
  | "publishWorkflow"
  | "pauseWorkflow"
  | "runWorkflow"
  | "dryRunCommand"
  | "executeCommand";

export type AgentToolBinding =
  | {
      kind: "query-service";
      service:
        | "workspaceInspector"
        | "appInspector"
        | "tableSchemaInspector"
        | "viewDefinitionInspector"
        | "workflowDefinitionInspector"
        | "workflowTestPreviewReader"
        | "permissionEngine"
        | "permissionPersonaPreviewReader"
        | "recordInspector"
        | "viewQueryReader"
        | "activityHistoryReader"
        | "workflowHistoryReader"
        | "workflowDependencyOperationsReader"
        | "workflowRunReader";
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
      kind: "workflow-operation";
      operation:
        | "aggregate-maintenance"
        | "backfill-disposition"
        | "lookup-maintenance"
        | "replay-dead-letter"
        | "sync-maintenance";
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

export type AgentToolManifest = {
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

export type CreateAppToolInput = AgentToolCommandBase & {
  appId: string;
  appName: string;
  appSlug: string;
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
  showEmptyGroups?: boolean;
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
  showEmptyGroups?: boolean;
};

export type DeleteViewToolInput = AgentToolCommandBase & {
  tableId: string;
  viewId: string;
};

export type PreviewWorkflowTestToolInput = {
  recordId: string;
  selectedFieldId?: string;
  workflowId: string;
  workspaceId: string;
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

export type UpdateFieldToolInput = AgentToolCommandBase & {
  tableId: string;
  fieldId: string;
  config: Record<string, unknown>;
};

export type ArchiveFieldToolInput = AgentToolCommandBase & {
  tableId: string;
  fieldId: string;
};

export type ReorderFieldsToolInput = AgentToolCommandBase & {
  tableId: string;
  fieldIds: string[];
};

export type CreateRecordToolInput = AgentToolCommandBase & {
  tableId: string;
  recordId: string;
  cells?: Record<string, unknown>;
};

export type UpdateRecordToolInput = AgentToolCommandBase & {
  tableId: string;
  recordId: string;
  patch: Record<string, unknown>;
};

export type BulkUpdateRecordsToolInput = AgentToolCommandBase & {
  tableId: string;
  updates: Array<{
    recordId: string;
    patch: Record<string, unknown>;
  }>;
};

export type ArchiveRecordToolInput = AgentToolCommandBase & {
  tableId: string;
  recordId: string;
};

export type UpdateCellToolInput = AgentToolCommandBase & {
  tableId: string;
  recordId: string;
  fieldId: string;
  value: unknown;
};

export type InspectWorkspaceToolInput = {
  workspaceId: string;
  include?: Array<"apps" | "tables" | "views" | "workflows" | "catalog">;
};

export type InspectAppToolInput = {
  workspaceId: string;
  appId: string;
};

export type ExplainPermissionsToolInput = {
  workspaceId: string;
  tableId?: string;
  viewId?: string;
  recordId?: string;
  fieldId: string;
  fieldType?: string;
  surfaces?: ExplainablePermissionSurface[];
};

export type PreviewPermissionPersonaToolInput = {
  workspaceId: string;
  tableId: string;
  viewId: string;
};

export type InspectTableSchemaToolInput = {
  workspaceId: string;
  tableId: string;
};

export type InspectViewDefinitionToolInput = {
  workspaceId: string;
  tableId: string;
  viewId: string;
};

export type InspectWorkflowDefinitionToolInput = {
  workspaceId: string;
  workflowId: string;
};

export type InspectRecordToolInput = {
  workspaceId: string;
  tableId: string;
  recordId: string;
};

export type QueryViewToolInput = {
  workspaceId: string;
  tableId: string;
  viewId: string;
};

export type ReadActivityHistoryToolInput = {
  workspaceId: string;
  tableId: string;
  recordId?: string;
  limit?: number;
  beforeTableSequence?: number;
};

export type ReadWorkspaceActivityHistoryToolInput = {
  workspaceId: string;
  limit?: number;
  beforeWorkspaceSequence?: number;
};

export type ReadAppActivityHistoryToolInput = {
  workspaceId: string;
  appId: string;
  limit?: number;
  beforeWorkspaceSequence?: number;
};

export type ProposeWorkflowToolInput = AgentToolCommandBase & {
  workflowId: string;
  name: string;
  tableId: string;
  businessRule: string;
  fieldIds?: string[];
  lookupFieldIds?: string[];
  relatedSourceFieldId?: string;
  relatedTargetFieldId?: string;
  rollupFieldIds?: string[];
  syncSourceFieldId?: string;
  syncTargetFieldId?: string;
  triggerId: string;
  actionIds: string[];
};

export type PublishWorkflowToolInput = AgentToolCommandBase & {
  tableId: string;
  workflowId: string;
};

export type UpdateWorkflowToolInput = AgentToolCommandBase & {
  tableId: string;
  workflowId: string;
  name: string;
  definition: Record<string, unknown>;
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

export type ReadWorkflowDependenciesToolInput = {
  workflowId: string;
  workspaceId: string;
};

export type ReadWorkflowRunDetailToolInput = {
  workflowRunId: string;
  workspaceId: string;
};

export type WorkflowDeadLetterReplayToolInput = AgentToolCommandBase & {
  deadLetterId: string;
  replayRequestId?: string;
};

export type WorkflowMaintenanceToolInput = AgentToolCommandBase & {
  changedFieldIds?: string[];
  kind: "backfill" | "recompute";
  reason?: string;
  recordId?: string;
  requestId?: string;
  workflowId: string;
};

export type WorkflowAggregateMaintenanceToolInput = WorkflowMaintenanceToolInput & {
  aggregateAliases?: string[];
};

export type WorkflowLookupMaintenanceToolInput = WorkflowMaintenanceToolInput & {
  lookupAliases?: string[];
  targetRecordId?: string;
};

export type WorkflowSyncMaintenanceToolInput = WorkflowMaintenanceToolInput & {
  syncAliases?: string[];
  targetRecordId?: string;
};

export type WorkflowBackfillDispositionToolInput = AgentToolCommandBase & {
  disposition: "abandoned" | "superseded";
  jobId: string;
  reason: string;
  supersededByJobId?: string;
  workflowId: string;
};

export type WorkspaceInspection = {
  workspaceId: string;
  apps: Array<{
    appId: string;
    name: string;
    slug: string;
    tableIds: string[];
  }>;
  tables: Array<{
    tableId: string;
    name: string;
    fieldIds: string[];
    view: ViewAuthoringMetadata;
    workflow: WorkflowAuthoringMetadata;
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
    aggregateOperations?: AggregateOperationManifest[];
    fieldTypes: FieldTypeManifest[];
    agentTools: AgentToolManifest[];
    workflowOperators: WorkflowOperatorManifest[];
  };
};

export type AppInspection = {
  workspaceId: string;
  appId: string;
  name: string;
  slug: string;
  tableIds: string[];
  tableCount: number;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceInspector = {
  inspect(input: InspectWorkspaceToolInput): Promise<WorkspaceInspection> | WorkspaceInspection;
};

export type AppInspector = {
  inspect(input: InspectAppToolInput): Promise<AppInspection | null> | AppInspection | null;
};

export type TableSchemaInspector = {
  read(
    input: InspectTableSchemaToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type ViewDefinitionInspector = {
  read(
    input: InspectViewDefinitionToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type WorkflowDefinitionInspector = {
  read(
    input: InspectWorkflowDefinitionToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type WorkflowTestPreviewReader = {
  read(
    input: PreviewWorkflowTestToolInput
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WorkflowHistoryReader = {
  read(
    input: ReadWorkflowHistoryToolInput
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WorkflowDependencyOperationsReader = {
  read(
    input: ReadWorkflowDependenciesToolInput
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WorkflowRunReader = {
  read(
    input: ReadWorkflowRunDetailToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type WorkflowDeadLetterReplayRequester = {
  requestReplay(
    input: WorkflowDeadLetterReplayToolInput
  ):
    | Promise<
        | {
            deadLetterId: string;
            replayRequestId: string;
            status: "enqueued";
          }
        | {
            deadLetterId: string;
            message: string;
            replayRequestId: string;
            reason: "already_requested" | "not_found" | "not_replayable";
            status: "rejected";
          }
      >
    | {
        deadLetterId: string;
        replayRequestId: string;
        status: "enqueued";
      }
    | {
        deadLetterId: string;
        message: string;
        replayRequestId: string;
        reason: "already_requested" | "not_found" | "not_replayable";
        status: "rejected";
      };
};

export type WorkflowMaintenanceRequesterResult =
  | {
      aliases: string[];
      requestId: string;
      status: "enqueued";
      workflowId: string;
      workflowVersionId: string;
    }
  | {
      aliases?: string[];
      message: string;
      reason:
        | "aggregate_alias_not_found"
        | "aggregate_not_configured"
        | "already_requested"
        | "lookup_alias_not_found"
        | "lookup_not_configured"
        | "sync_alias_not_found"
        | "sync_not_configured"
        | "workflow_not_found"
        | "workflow_paused"
        | "workflow_service_identity_invalid";
      requestId: string;
      status: "rejected";
      workflowId: string;
    };

export type WorkflowAggregateMaintenanceRequester = {
  requestMaintenance(
    input: WorkflowAggregateMaintenanceToolInput
  ): Promise<WorkflowMaintenanceRequesterResult> | WorkflowMaintenanceRequesterResult;
};

export type WorkflowLookupMaintenanceRequester = {
  requestMaintenance(
    input: WorkflowLookupMaintenanceToolInput
  ): Promise<WorkflowMaintenanceRequesterResult> | WorkflowMaintenanceRequesterResult;
};

export type WorkflowSyncMaintenanceRequester = {
  requestMaintenance(
    input: WorkflowSyncMaintenanceToolInput
  ): Promise<WorkflowMaintenanceRequesterResult> | WorkflowMaintenanceRequesterResult;
};

export type WorkflowBackfillDispositionRequesterResult =
  | {
      jobId: string;
      operatorReason: string;
      status: "abandoned" | "superseded";
      supersededByJobId: string | null;
      workflowId: string;
    }
  | {
      jobId: string;
      message: string;
      reason: "backfill_job_not_found" | "backfill_job_terminal" | "invalid_supersede_target";
      status: "rejected";
      workflowId: string;
    };

export type WorkflowBackfillDispositionRequester = {
  requestDisposition(
    input: WorkflowBackfillDispositionToolInput
  ): Promise<WorkflowBackfillDispositionRequesterResult> | WorkflowBackfillDispositionRequesterResult;
};

export type RecordInspector = {
  read(
    input: InspectRecordToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type ViewQueryReader = {
  read(input: QueryViewToolInput): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type PermissionPersonaPreviewReader = {
  read(
    input: PreviewPermissionPersonaToolInput
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
};

export type ActivityHistoryReader = {
  read(
    input:
      | ReadActivityHistoryToolInput
      | ReadWorkspaceActivityHistoryToolInput
      | ReadAppActivityHistoryToolInput
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type AgentToolAuditDiff = {
  action: "create" | "update" | "delete" | "propose";
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
  metadata?: WorkflowDefinitionMetadata;
  trigger:
    | WorkflowTriggerManifest
    | {
        id: string;
        kind: "trigger";
      };
  actions: WorkflowActionManifest[];
};

export type AgentToolInvocation =
  | {
      toolId: "inspectWorkspace";
      input: InspectWorkspaceToolInput;
    }
  | {
      toolId: "inspectApp";
      input: InspectAppToolInput;
    }
  | {
      toolId: "inspectTableSchema";
      input: InspectTableSchemaToolInput;
    }
  | {
      toolId: "inspectViewDefinition";
      input: InspectViewDefinitionToolInput;
    }
  | {
      toolId: "inspectWorkflowDefinition";
      input: InspectWorkflowDefinitionToolInput;
    }
  | {
      toolId: "previewWorkflowTest";
      input: PreviewWorkflowTestToolInput;
    }
  | {
      toolId: "explainPermissions";
      input: ExplainPermissionsToolInput;
    }
  | {
      toolId: "previewPermissionPersona";
      input: PreviewPermissionPersonaToolInput;
    }
  | {
      toolId: "inspectRecord";
      input: InspectRecordToolInput;
    }
  | {
      toolId: "queryView";
      input: QueryViewToolInput;
    }
  | {
      toolId: "readActivityHistory";
      input: ReadActivityHistoryToolInput;
    }
  | {
      toolId: "readWorkspaceActivityHistory";
      input: ReadWorkspaceActivityHistoryToolInput;
    }
  | {
      toolId: "readAppActivityHistory";
      input: ReadAppActivityHistoryToolInput;
    }
  | {
      toolId: "readWorkflowHistory";
      input: ReadWorkflowHistoryToolInput;
    }
  | {
      toolId: "readWorkflowDependencies";
      input: ReadWorkflowDependenciesToolInput;
    }
  | {
      toolId: "readWorkflowRunDetail";
      input: ReadWorkflowRunDetailToolInput;
    }
  | {
      toolId: "prepareWorkflowDeadLetterReplay";
      input: WorkflowDeadLetterReplayToolInput;
    }
  | {
      toolId: "requestWorkflowDeadLetterReplay";
      input: WorkflowDeadLetterReplayToolInput;
    }
  | {
      toolId: "prepareWorkflowAggregateMaintenance";
      input: WorkflowAggregateMaintenanceToolInput;
    }
  | {
      toolId: "requestWorkflowAggregateMaintenance";
      input: WorkflowAggregateMaintenanceToolInput;
    }
  | {
      toolId: "prepareWorkflowLookupMaintenance";
      input: WorkflowLookupMaintenanceToolInput;
    }
  | {
      toolId: "requestWorkflowLookupMaintenance";
      input: WorkflowLookupMaintenanceToolInput;
    }
  | {
      toolId: "prepareWorkflowSyncMaintenance";
      input: WorkflowSyncMaintenanceToolInput;
    }
  | {
      toolId: "requestWorkflowSyncMaintenance";
      input: WorkflowSyncMaintenanceToolInput;
    }
  | {
      toolId: "prepareWorkflowBackfillDisposition";
      input: WorkflowBackfillDispositionToolInput;
    }
  | {
      toolId: "requestWorkflowBackfillDisposition";
      input: WorkflowBackfillDispositionToolInput;
    }
  | {
      toolId: "createApp";
      input: CreateAppToolInput;
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
      toolId: "deleteView";
      input: DeleteViewToolInput;
    }
  | {
      toolId: "configureFieldPermission";
      input: ConfigureFieldPermissionToolInput;
    }
  | {
      toolId: "updateField";
      input: UpdateFieldToolInput;
    }
  | {
      toolId: "archiveField";
      input: ArchiveFieldToolInput;
    }
  | {
      toolId: "reorderFields";
      input: ReorderFieldsToolInput;
    }
  | {
      toolId: "createRecord";
      input: CreateRecordToolInput;
    }
  | {
      toolId: "updateRecord";
      input: UpdateRecordToolInput;
    }
  | {
      toolId: "bulkUpdateRecords";
      input: BulkUpdateRecordsToolInput;
    }
  | {
      toolId: "archiveRecord";
      input: ArchiveRecordToolInput;
    }
  | {
      toolId: "updateCell";
      input: UpdateCellToolInput;
    }
  | {
      toolId: "proposeWorkflow";
      input: ProposeWorkflowToolInput;
    }
  | {
      toolId: "updateWorkflow";
      input: UpdateWorkflowToolInput;
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
      kind: "app-inspection";
      app: AppInspection | null;
    }
  | {
      kind: "table-schema-inspection";
      schema: Record<string, unknown> | null;
    }
  | {
      kind: "view-definition-inspection";
      view: Record<string, unknown> | null;
    }
  | {
      kind: "workflow-definition-inspection";
      workflow: Record<string, unknown> | null;
    }
  | {
      kind: "workflow-test-preview";
      preview: Record<string, unknown>;
    }
  | {
      kind: "permission-explanation";
      explanation: FieldPermissionExplanation & {
        scope: {
          recordId: string | null;
          workspaceId: string;
          tableId: string | null;
          viewId: string | null;
        };
      };
    }
  | {
      kind: "permission-persona-preview";
      preview: Record<string, unknown> | null;
    }
  | {
      kind: "record-inspection";
      record: Record<string, unknown> | null;
    }
  | {
      kind: "view-query";
      view: Record<string, unknown> | null;
    }
  | {
      kind: "activity-history";
      activity: Record<string, unknown>;
    }
  | {
      kind: "workflow-history";
      history: Record<string, unknown>;
    }
  | {
      dependencies: Record<string, unknown>;
      kind: "workflow-dependencies";
    }
  | {
      kind: "workflow-run-detail";
      run: Record<string, unknown> | null;
    }
  | {
      kind: "workflow-dead-letter-replay-draft";
      diffs: AgentToolAuditDiff[];
      request: {
        deadLetterId: string;
        replayRequestId: string;
        workspaceId: string;
      };
    }
  | {
      deadLetterId: string;
      kind: "workflow-dead-letter-replay";
      message?: string;
      reason?: "already_requested" | "not_found" | "not_replayable";
      replayRequestId: string;
      status: "enqueued" | "rejected";
    }
  | {
      diffs: AgentToolAuditDiff[];
      kind: "workflow-maintenance-draft";
      request: {
        aliases?: string[];
        changedFieldIds?: string[];
        dependencyKind: "aggregate" | "lookup" | "sync";
        kind: "backfill" | "recompute";
        reason?: string;
        recordId?: string;
        requestId: string;
        targetRecordId?: string;
        workflowId: string;
        workspaceId: string;
      };
      successorInvocation:
        | {
            input: {
              aggregateAliases?: string[];
              changedFieldIds?: string[];
              kind: "backfill" | "recompute";
              reason?: string;
              recordId?: string;
              requestId: string;
              workflowId: string;
              workspaceId: string;
            };
            toolId: "requestWorkflowAggregateMaintenance";
          }
        | {
            input: {
              changedFieldIds?: string[];
              kind: "backfill" | "recompute";
              lookupAliases?: string[];
              reason?: string;
              recordId?: string;
              requestId: string;
              targetRecordId?: string;
              workflowId: string;
              workspaceId: string;
            };
            toolId: "requestWorkflowLookupMaintenance";
          }
        | {
            input: {
              changedFieldIds?: string[];
              kind: "backfill" | "recompute";
              reason?: string;
              recordId?: string;
              requestId: string;
              syncAliases?: string[];
              targetRecordId?: string;
              workflowId: string;
              workspaceId: string;
            };
            toolId: "requestWorkflowSyncMaintenance";
          };
    }
  | ({
      dependencyKind: "aggregate" | "lookup" | "sync";
      kind: "workflow-maintenance-request";
    } & WorkflowMaintenanceRequesterResult)
  | {
      diffs: AgentToolAuditDiff[];
      kind: "workflow-backfill-disposition-draft";
      request: {
        disposition: "abandoned" | "superseded";
        jobId: string;
        reason: string;
        supersededByJobId?: string;
        workflowId: string;
        workspaceId: string;
      };
      successorInvocation: {
        input: {
          disposition: "abandoned" | "superseded";
          jobId: string;
          reason: string;
          supersededByJobId?: string;
          workflowId: string;
          workspaceId: string;
        };
        toolId: "requestWorkflowBackfillDisposition";
      };
    }
  | ({
      kind: "workflow-backfill-disposition";
    } & WorkflowBackfillDispositionRequesterResult)
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
