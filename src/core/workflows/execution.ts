import type {
  WorkflowActionDefinition,
  WorkflowActionExecutionContext,
  WorkflowActionExecutor,
  WorkflowActionInput,
  WorkflowActionExecution,
  WorkflowConditionBinding,
  WorkflowConditionDefinition,
  WorkflowConditionEvaluation,
  WorkflowConditionInput,
  WorkflowDefinition,
  WorkflowExecutionResult,
  WorkflowExecutionScope,
  WorkflowOperatorRegistry,
  WorkflowTriggerDefinition,
  WorkflowValueTemplate
} from "./types";

export function evaluateWorkflowCondition(
  operator: WorkflowConditionDefinition,
  input: WorkflowConditionInput
): boolean {
  return operator.evaluate(input);
}

export function executeWorkflowAction(
  operator: WorkflowActionDefinition,
  input: WorkflowActionInput,
  context: WorkflowActionExecutionContext,
  executor: WorkflowActionExecutor
) {
  return executor.execute(operator.createCommand(input, context));
}

function isPathTemplate(value: WorkflowValueTemplate): value is { path: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

function getPathValue(scope: WorkflowExecutionScope, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (current, segment) =>
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[segment]
          : undefined,
      scope as unknown
    );
}

export function resolveWorkflowTemplate(
  template: WorkflowValueTemplate,
  scope: WorkflowExecutionScope
): unknown {
  if (isPathTemplate(template)) {
    return getPathValue(scope, template.path);
  }

  if (Array.isArray(template)) {
    return template.map((value) =>
      resolveWorkflowTemplate(value as WorkflowValueTemplate, scope)
    );
  }

  if (template && typeof template === "object") {
    return Object.entries(template as Record<string, WorkflowValueTemplate>).reduce<
      Record<string, unknown>
    >((resolved, [key, value]) => {
      resolved[key] = resolveWorkflowTemplate(value, scope);
      return resolved;
    }, {});
  }

  return template;
}

export function resolveWorkflowInput(
  input: WorkflowConditionInput | WorkflowActionInput,
  scope: WorkflowExecutionScope
): Record<string, unknown> {
  return Object.entries(input).reduce<Record<string, unknown>>((resolved, [key, value]) => {
    resolved[key] = resolveWorkflowTemplate(value as WorkflowValueTemplate, scope);
    return resolved;
  }, {});
}

export function matchWorkflowTrigger(
  operator: WorkflowTriggerDefinition,
  trigger: WorkflowDefinition["trigger"],
  scope: WorkflowExecutionScope
): boolean {
  const matcher = trigger.match;
  const eventTypes = matcher?.eventTypes ?? operator.triggerEventTypes;

  if (eventTypes.length > 0 && !eventTypes.includes(scope.event.eventType)) {
    return false;
  }

  if (matcher?.tableId && matcher.tableId !== scope.event.tableId) {
    return false;
  }

  if (matcher?.fieldId) {
    const payloadFieldId =
      typeof scope.event.payload.fieldId === "string" ? scope.event.payload.fieldId : null;
    if (payloadFieldId !== matcher.fieldId) {
      return false;
    }
  }

  if (matcher?.fromWorkflow === false) {
    const actorMode =
      scope.event.metadata &&
      typeof scope.event.metadata === "object" &&
      typeof (scope.event.metadata as Record<string, unknown>).actor === "object"
        ? ((scope.event.metadata as Record<string, unknown>).actor as Record<string, unknown>)
            .mode
        : undefined;

    if (actorMode === "workflow") {
      return false;
    }
  }

  return true;
}

function buildActionExecutionContext(
  workflow: WorkflowDefinition,
  actionIndex: number,
  resolvedInput: WorkflowActionInput,
  scope: WorkflowExecutionScope
): WorkflowActionExecutionContext {
  const resolvedTableId =
    typeof resolvedInput.tableId === "string" && resolvedInput.tableId.length > 0
      ? resolvedInput.tableId
      : scope.table?.tableId ?? scope.event.tableId ?? undefined;
  const resolvedFieldType =
    typeof resolvedInput.fieldType === "string" && resolvedInput.fieldType.length > 0
      ? resolvedInput.fieldType
      : scope.cell?.fieldType;

  return {
    actor: {
      mode: "workflow",
      principalId: workflow.principal?.principalId ?? scope.workflow.workflowId
    },
    commandId: `${scope.workflow.workflowRunId}:action:${actionIndex}`,
    idempotencyKey: `${scope.workflow.workflowRunId}:action:${actionIndex}`,
    payload: {
      ...(resolvedFieldType ? { fieldType: resolvedFieldType } : {}),
      triggerEventId: scope.workflow.triggerEventId,
      workflowId: workflow.workflowId,
      workflowRunId: scope.workflow.workflowRunId,
      workflowStepId: `${workflow.workflowId}:action:${actionIndex}`
    },
    permissionScopeHash:
      workflow.principal?.scopeHash ??
      (typeof scope.event.metadata.permissionScopeHash === "string"
        ? scope.event.metadata.permissionScopeHash
        : undefined),
    permissionsVersion:
      workflow.principal?.policyRevision ??
      (typeof scope.event.metadata.permissionsVersion === "number"
        ? scope.event.metadata.permissionsVersion
        : undefined),
    schemaEpoch:
      workflow.principal?.schemaEpoch ??
      (typeof scope.event.metadata.schemaEpoch === "number"
        ? scope.event.metadata.schemaEpoch
        : undefined),
    tableId: resolvedTableId,
    workspaceId: scope.event.workspaceId
  };
}

function shouldSkipForLoopGuard(
  workflow: WorkflowDefinition,
  actionInput: WorkflowActionInput,
  scope: WorkflowExecutionScope
): boolean {
  const metadata = scope.event.metadata;
  if (!metadata || typeof metadata !== "object") {
    return false;
  }

  const workflowId = (metadata as Record<string, unknown>).workflowId;
  const triggerEventId = (metadata as Record<string, unknown>).triggerEventId;
  const actionTableId =
    typeof actionInput.tableId === "string" && actionInput.tableId.length > 0
      ? actionInput.tableId
      : scope.table?.tableId ?? scope.event.tableId;
  const actionFieldId =
    typeof actionInput.fieldId === "string" && actionInput.fieldId.length > 0
      ? actionInput.fieldId
      : scope.cell?.fieldId;
  const eventFieldId =
    typeof scope.event.payload.fieldId === "string" ? scope.event.payload.fieldId : scope.cell?.fieldId;
  const eventTableId = scope.event.tableId ?? scope.table?.tableId;

  return (
    workflowId === workflow.workflowId &&
    triggerEventId === scope.workflow.triggerEventId &&
    actionTableId === eventTableId &&
    actionFieldId === eventFieldId
  );
}

export function evaluateWorkflowConditions(
  conditions: readonly WorkflowConditionBinding[],
  registry: WorkflowOperatorRegistry,
  scope: WorkflowExecutionScope
): WorkflowConditionEvaluation[] {
  return conditions.map((condition) => {
    const definition = registry.require(condition.operatorId);
    if (definition.kind !== "condition") {
      throw new Error(`Workflow operator ${condition.operatorId} is not a condition.`);
    }

    const resolvedInput = resolveWorkflowInput(condition.input, scope);
    return {
      operatorId: condition.operatorId,
      passed: evaluateWorkflowCondition(definition, resolvedInput),
      resolvedInput
    };
  });
}

export async function executeWorkflowDefinition(
  workflow: WorkflowDefinition,
  scope: WorkflowExecutionScope,
  registry: WorkflowOperatorRegistry,
  executor: WorkflowActionExecutor
): Promise<WorkflowExecutionResult> {
  const trigger = registry.require(workflow.trigger.operatorId);
  if (trigger.kind !== "trigger") {
    throw new Error(`Workflow operator ${workflow.trigger.operatorId} is not a trigger.`);
  }

  if (!matchWorkflowTrigger(trigger, workflow.trigger, scope)) {
    return {
      matchedTrigger: false,
      workflowId: workflow.workflowId
    };
  }

  const conditionResults = evaluateWorkflowConditions(workflow.conditions, registry, scope);
  if (conditionResults.some((condition) => !condition.passed)) {
    return {
      conditionResults,
      executedActions: [],
      matchedTrigger: true,
      skippedReason: "conditions_failed",
      workflowId: workflow.workflowId
    };
  }

  const executedActions: WorkflowActionExecution[] = [];
  for (const [actionIndex, action] of workflow.actions.entries()) {
    const definition = registry.require(action.operatorId);
    if (definition.kind !== "action") {
      throw new Error(`Workflow operator ${action.operatorId} is not an action.`);
    }

    const resolvedInput = resolveWorkflowInput(action.input, scope);
    if (shouldSkipForLoopGuard(workflow, resolvedInput, scope)) {
      executedActions.push({
        command: definition.createCommand(
          resolvedInput,
          buildActionExecutionContext(workflow, actionIndex, resolvedInput, scope)
        ),
        operatorId: action.operatorId,
        result: {
          accepted: false,
          diagnostics: ["workflow_loop_guard"],
          events: [],
          permission: {
            allowed: false,
            reasons: ["workflow_loop_guard"]
          },
          replayProjection: {
            acceptedCommandIds: [],
            lastLogicalTime: scope.event.createdAt,
            receiptCount: 0,
            receipts: []
          },
          sideEffects: [],
          status: "rejected"
        },
        skipped: "loop_guard"
      });
      continue;
    }

    const context = buildActionExecutionContext(workflow, actionIndex, resolvedInput, scope);
    const result = await executeWorkflowAction(definition, resolvedInput, context, executor);
    executedActions.push({
      command: definition.createCommand(resolvedInput, context),
      operatorId: action.operatorId,
      result
    });
  }

  return {
    conditionResults,
    executedActions,
    matchedTrigger: true,
    workflowId: workflow.workflowId
  };
}
