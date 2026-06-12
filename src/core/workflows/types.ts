import type {
  CommandActor,
  CommandEnvelope,
  CommandResult,
  CommandScope
} from "../commands/types";
import type { EventLedgerRecord } from "../events/types";
import type { FieldWorkflowProposalHint, JsonSchema } from "../field-types/types";

export type WorkflowOperatorKind = "trigger" | "condition" | "action";

export type WorkflowOperatorCapability =
  | "records.read"
  | "records.write"
  | "fields.read"
  | "workflows.execute"
  | "notifications.emit"
  | "webhooks.deliver"
  | "jobs.enqueue";

export type WorkflowOperatorPurity = "pure" | "impure";
export type WorkflowOperatorIdempotencyMode =
  | "deterministic"
  | "delivery_key"
  | "command_idempotency_key";
export type WorkflowOperatorTimeoutClass = "fast" | "standard" | "network";
export type WorkflowOperatorRetryClass = "none" | "standard" | "network";

export type WorkflowConditionInput = Record<string, unknown>;
export type WorkflowActionInput = Record<string, unknown>;

export type WorkflowActionExecutionContext = {
  actor: CommandActor;
  commandId: string;
  idempotencyKey: string;
  permissionScopeHash?: string;
  permissionsVersion?: number;
  payload: Record<string, unknown>;
  schemaEpoch?: number;
  tableId?: string;
  workspaceId: string;
};

export type WorkflowActionExecutor = {
  execute(command: CommandEnvelope): Promise<CommandResult>;
};

export type WorkflowValueTemplate =
  | unknown
  | {
      path: string;
    };

export type WorkflowFieldValue = {
  fieldId: string;
  fieldType?: string;
  value: unknown;
};

export type WorkflowRowContext = {
  owner?: WorkflowFieldValue;
  recordId: string;
  fields: Record<string, WorkflowFieldValue>;
};

export type WorkflowTableContext = {
  tableId: string;
  fields?: Record<string, WorkflowFieldValue>;
  row?: WorkflowRowContext;
};

export type WorkflowCellContext = WorkflowFieldValue & {
  recordId: string;
  tableId: string;
};

export type WorkflowExecutionEvent = EventLedgerRecord;

export type WorkflowExecutionScope = {
  cell?: WorkflowCellContext;
  event: WorkflowExecutionEvent;
  relatedTables?: Record<string, WorkflowTableContext>;
  row?: WorkflowRowContext;
  table?: WorkflowTableContext;
  workflow: {
    triggerEventId: string;
    workflowId: string;
    workflowRunId: string;
  };
};

export type WorkflowTriggerMatcher = {
  eventTypes?: readonly string[];
  fieldIds?: readonly string[];
  fieldId?: string;
  fromWorkflow?: boolean;
  tableId?: string;
};

export type WorkflowTriggerBinding = {
  operatorId: string;
  match?: WorkflowTriggerMatcher;
};

export type WorkflowConditionBinding = {
  input: WorkflowConditionInput;
  operatorId: string;
};

export type WorkflowActionBinding = {
  input: WorkflowActionInput;
  operatorId: string;
};

export type WorkflowDefinition = {
  actions: readonly WorkflowActionBinding[];
  conditions: readonly WorkflowConditionBinding[];
  principal?: {
    policyRevision?: number;
    principalId: string;
    schemaEpoch?: number;
    scopeHash?: string;
  };
  trigger: WorkflowTriggerBinding;
  workflowId: string;
};

export type WorkflowConditionEvaluation = {
  passed: boolean;
  resolvedInput: WorkflowConditionInput;
  operatorId: string;
};

export type WorkflowActionExecution = {
  command: CommandEnvelope;
  operatorId: string;
  result: CommandResult;
  skipped?: "loop_guard";
};

export type WorkflowExecutionResult =
  | {
      matchedTrigger: false;
      workflowId: string;
    }
  | {
      conditionResults: readonly WorkflowConditionEvaluation[];
      matchedTrigger: true;
      workflowId: string;
      executedActions: readonly WorkflowActionExecution[];
      skippedReason?: "conditions_failed";
    };

export type WorkflowOperatorFixture =
  | {
      id: string;
      kind: "condition";
      input: WorkflowConditionInput;
      expected: boolean;
    }
  | {
      id: string;
      kind: "action";
      input: WorkflowActionInput;
      expectedCommandType: string;
      expectedPayload: Record<string, unknown>;
    };

export type WorkflowOperatorFixtureManifest = {
  id: string;
  kind: WorkflowOperatorFixture["kind"];
};

type WorkflowOperatorDefinitionBase = {
  id: string;
  kind: WorkflowOperatorKind;
  version: number;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requiredCapabilities: readonly WorkflowOperatorCapability[];
  purity: WorkflowOperatorPurity;
  idempotencyMode: WorkflowOperatorIdempotencyMode;
  timeoutClass: WorkflowOperatorTimeoutClass;
  retryClass: WorkflowOperatorRetryClass;
  fixtureContract: readonly WorkflowOperatorFixture[];
};

type WorkflowOperatorManifestBase = {
  fixtureContract: readonly WorkflowOperatorFixtureManifest[];
  id: string;
  idempotencyMode: WorkflowOperatorIdempotencyMode;
  inputSchema: JsonSchema;
  kind: WorkflowOperatorKind;
  outputSchema: JsonSchema;
  purity: WorkflowOperatorPurity;
  requiredCapabilities: readonly WorkflowOperatorCapability[];
  retryClass: WorkflowOperatorRetryClass;
  timeoutClass: WorkflowOperatorTimeoutClass;
  version: number;
};

export type WorkflowTriggerDefinition = WorkflowOperatorDefinitionBase & {
  kind: "trigger";
  triggerEventTypes: readonly string[];
};

export type WorkflowConditionDefinition = WorkflowOperatorDefinitionBase & {
  kind: "condition";
  evaluate(input: WorkflowConditionInput): boolean;
};

export type WorkflowActionDefinition = WorkflowOperatorDefinitionBase & {
  kind: "action";
  commandType: string;
  commandScope: CommandScope;
  proposalTemplate: WorkflowActionInput;
  createCommand(
    input: WorkflowActionInput,
    context: WorkflowActionExecutionContext
  ): CommandEnvelope;
};

export type WorkflowTriggerManifest = WorkflowOperatorManifestBase & {
  kind: "trigger";
  triggerEventTypes: readonly string[];
};

export type WorkflowConditionManifest = WorkflowOperatorManifestBase & {
  kind: "condition";
};

export type WorkflowActionManifest = WorkflowOperatorManifestBase & {
  kind: "action";
  commandScope: CommandScope;
  commandType: string;
  proposalTemplate: WorkflowActionInput;
};

export type WorkflowOperatorManifest =
  | WorkflowTriggerManifest
  | WorkflowConditionManifest
  | WorkflowActionManifest;

export type WorkflowConditionBindingMetadata = {
  aliasOf?: string;
  binding: string;
  fieldId: string;
  fieldKey: string;
  fieldType: string;
  isCanonical?: boolean;
  proposalHints: FieldWorkflowProposalHint[];
  supportedOperatorIds: string[];
  supportedOperators: WorkflowConditionManifest[];
  template: {
    fieldIdPath?: string;
    fieldTypePath?: string;
    input?: WorkflowConditionInput;
    valuePath?: string;
  };
};

export type WorkflowConditionInspectionMetadata = {
  diagnostics: string[];
  index: number;
  operator: WorkflowConditionManifest | null;
  operatorId: string;
  referencedBindingNames: string[];
  resolvedBindings: WorkflowConditionBindingMetadata[];
};

export type WorkflowAuthoringMetadata = {
  bindings: Record<string, WorkflowConditionBindingMetadata>;
};

export type WorkflowOperatorDefinition =
  | WorkflowTriggerDefinition
  | WorkflowConditionDefinition
  | WorkflowActionDefinition;

export type WorkflowOperatorRegistry = {
  get(id: string): WorkflowOperatorDefinition | undefined;
  has(id: string): boolean;
  list(): readonly WorkflowOperatorDefinition[];
  listByKind(kind: WorkflowOperatorKind): readonly WorkflowOperatorDefinition[];
  require(id: string): WorkflowOperatorDefinition;
};

export type CreateWorkflowOperatorRegistryInput = {
  definitions?: readonly WorkflowOperatorDefinition[];
};
