import type {
  WorkflowActionDefinition,
  WorkflowActionExecutionContext,
  WorkflowActionExecutor,
  WorkflowActionInput,
  WorkflowConditionDefinition,
  WorkflowConditionInput
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
