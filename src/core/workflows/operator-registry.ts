import { mvpWorkflowOperators } from "./operators";
import type {
  CreateWorkflowOperatorRegistryInput,
  WorkflowOperatorDefinition,
  WorkflowOperatorRegistry
} from "./types";

function assertUniqueWorkflowOperators(
  definitions: readonly WorkflowOperatorDefinition[]
): void {
  const seenIds = new Set<string>();

  for (const definition of definitions) {
    if (seenIds.has(definition.id)) {
      throw new Error(`Duplicate workflow operator registration: ${definition.id}`);
    }

    seenIds.add(definition.id);

    const fixtureIds = new Set<string>();
    for (const fixture of definition.fixtureContract) {
      if (fixtureIds.has(fixture.id)) {
        throw new Error(
          `Duplicate fixture id for workflow operator ${definition.id}: ${fixture.id}`
        );
      }

      fixtureIds.add(fixture.id);
    }
  }
}

export function createWorkflowOperatorRegistry(
  input: CreateWorkflowOperatorRegistryInput = {}
): WorkflowOperatorRegistry {
  const definitions = input.definitions ?? mvpWorkflowOperators;

  assertUniqueWorkflowOperators(definitions);

  const orderedDefinitions = [...definitions];
  const registry = new Map(
    orderedDefinitions.map((definition) => [definition.id, definition])
  );

  return {
    get(id: string) {
      return registry.get(id);
    },
    has(id: string) {
      return registry.has(id);
    },
    list() {
      return orderedDefinitions;
    },
    listByKind(kind) {
      return orderedDefinitions.filter((definition) => definition.kind === kind);
    },
    require(id: string) {
      const definition = registry.get(id);

      if (!definition) {
        throw new Error(`Unknown workflow operator: ${id}`);
      }

      return definition;
    }
  };
}
