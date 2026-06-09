import type {
  FieldTypeDefinition,
  FieldTypeManifest
} from "./types";

export function serializeFieldTypeManifest(definition: FieldTypeDefinition): FieldTypeManifest {
  return {
    capabilities: definition.capabilities,
    configSchema: definition.configSchema,
    defaultConfig: definition.defaultConfig,
    permissionBehavior: definition.getPermissionBehavior({
      fieldType: definition.type,
      fieldConfig: definition.defaultConfig
    }),
    supportedConditionOperators: definition.supportedConditionOperators,
    supportedSortModes: definition.supportedSortModes,
    type: definition.type,
    valueSchema: definition.valueSchema,
    version: definition.version
  };
}
