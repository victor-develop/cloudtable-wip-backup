import type { FieldTypeRegistry } from "../field-types/types";
import type { PermissionEngine } from "../permissions/types";

export type ViewPlanner = {
  describe(): {
    consistencyModel: "direct_record_strong" | "view_eventual";
    dependsOn: string[];
  };
  describeField(fieldType: string): {
    capabilities: ReturnType<FieldTypeRegistry["require"]>["capabilities"];
    supportedConditionOperators: readonly string[];
    supportedSortModes: readonly string[];
  };
};

export function createViewPlanner(
  fieldTypeRegistry: FieldTypeRegistry,
  _permissionEngine: PermissionEngine
): ViewPlanner {
  return {
    describe() {
      return {
        consistencyModel: "view_eventual",
        dependsOn: ["record_projection", "field_index_entries", "permission_engine"]
      };
    },
    describeField(fieldType) {
      const definition = fieldTypeRegistry.require(fieldType);

      return {
        capabilities: definition.capabilities,
        supportedConditionOperators: definition.getSupportedConditionOperators({
          fieldType
        }),
        supportedSortModes: definition.getSupportedSortModes({
          fieldType
        })
      };
    }
  };
}
