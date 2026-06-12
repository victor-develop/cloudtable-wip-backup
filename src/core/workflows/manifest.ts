import type {
  WorkflowOperatorDefinition,
  WorkflowOperatorManifest
} from "./types";

export function serializeWorkflowOperatorManifest(
  definition: WorkflowOperatorDefinition
): WorkflowOperatorManifest {
  const base = {
    fixtureContract: definition.fixtureContract.map((fixture) => ({
      id: fixture.id,
      kind: fixture.kind
    })),
    id: definition.id,
    idempotencyMode: definition.idempotencyMode,
    inputSchema: definition.inputSchema,
    kind: definition.kind,
    outputSchema: definition.outputSchema,
    purity: definition.purity,
    requiredCapabilities: definition.requiredCapabilities,
    retryClass: definition.retryClass,
    timeoutClass: definition.timeoutClass,
    version: definition.version
  };

  if (definition.kind === "trigger") {
    return {
      ...base,
      kind: "trigger",
      triggerEventTypes: definition.triggerEventTypes
    };
  }

  if (definition.kind === "action") {
    return {
      ...base,
      commandScope: definition.commandScope,
      commandType: definition.commandType,
      kind: "action",
      proposalTemplate: definition.proposalTemplate
    };
  }

  return {
    ...base,
    kind: "condition"
  };
}
