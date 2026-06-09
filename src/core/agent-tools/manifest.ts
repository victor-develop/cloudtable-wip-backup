import type {
  AgentToolDefinition,
  AgentToolManifest
} from "./types";

export function serializeAgentToolManifest(definition: AgentToolDefinition): AgentToolManifest {
  return {
    binding: definition.binding,
    description: definition.description,
    fieldBinding: definition.fieldBinding,
    ...(definition.fieldIds ? { fieldIds: definition.fieldIds } : {}),
    id: definition.id,
    inputSchema: definition.inputSchema,
    mutating: definition.mutating,
    mutationTarget: definition.mutationTarget,
    outputSchema: definition.outputSchema,
    phase: definition.phase,
    requiresConfirmation: definition.requiresConfirmation,
    scope: definition.scope,
    ...(definition.successorToolId ? { successorToolId: definition.successorToolId } : {})
  };
}
