import type { CommandActor, CommandEnvelope, CommandResult } from "../commands/types";
import type { JsonSchema } from "../field-types/types";

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
  createCommand(
    input: WorkflowActionInput,
    context: WorkflowActionExecutionContext
  ): CommandEnvelope;
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
