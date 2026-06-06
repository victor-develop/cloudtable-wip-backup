import { mvpFieldTypes } from "./modules";
import type {
  CreateFieldTypeRegistryInput,
  FieldTypeDefinition,
  FieldTypeRegistry
} from "./types";

function assertUniqueFieldTypes(fieldTypes: readonly FieldTypeDefinition[]): void {
  const seenTypes = new Set<string>();

  for (const fieldType of fieldTypes) {
    if (seenTypes.has(fieldType.type)) {
      throw new Error(`Duplicate field type registration: ${fieldType.type}`);
    }

    seenTypes.add(fieldType.type);

    const fixtureIds = new Set<string>();
    for (const fixture of fieldType.fixtures) {
      if (fixtureIds.has(fixture.id)) {
        throw new Error(
          `Duplicate fixture id for ${fieldType.type}: ${fixture.id}`
        );
      }

      fixtureIds.add(fixture.id);
    }
  }
}

export function createFieldTypeRegistry(
  input: CreateFieldTypeRegistryInput = {}
): FieldTypeRegistry {
  const fieldTypes = input.fieldTypes ?? mvpFieldTypes;

  assertUniqueFieldTypes(fieldTypes);

  const orderedFieldTypes = [...fieldTypes];
  const registry = new Map(orderedFieldTypes.map((definition) => [definition.type, definition]));

  return {
    get(type: string) {
      return registry.get(type);
    },
    has(type: string) {
      return registry.has(type);
    },
    list() {
      return orderedFieldTypes;
    },
    require(type: string) {
      const definition = registry.get(type);

      if (!definition) {
        throw new Error(`Unknown field type: ${type}`);
      }

      return definition;
    }
  };
}
