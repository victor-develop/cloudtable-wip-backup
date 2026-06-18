import type {
  AggregateOperationDefinition,
  AggregateOperationManifest
} from "./types";

export function serializeAggregateOperationManifest(
  definition: AggregateOperationDefinition
): AggregateOperationManifest {
  return {
    configSchema: definition.configSchema,
    description: definition.description,
    id: definition.id,
    ...(definition.operand ? { operand: definition.operand } : {})
  };
}
