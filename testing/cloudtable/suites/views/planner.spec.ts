import { describe, expect, it } from "vitest";

import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import { createViewPlanner } from "../../../../src/core/views/planner";

const fieldTypeRegistry = createFieldTypeRegistry();
const permissionEngine = createPermissionEngine(fieldTypeRegistry);
const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);

describe("cloudtable view determinism seam", () => {
  it("describes the stable view planner dependencies", () => {
    expect(viewPlanner.describe()).toEqual({
      consistencyModel: "view_eventual",
      dependsOn: ["record_projection", "field_index_entries", "permission_engine"]
    });
  });

  for (const fieldType of fieldTypeRegistry.list()) {
    it(`matches field view capabilities for ${fieldType.type}`, () => {
      expect(viewPlanner.describeField(fieldType.type)).toEqual({
        capabilities: fieldType.capabilities,
        supportedConditionOperators: fieldType.supportedConditionOperators,
        supportedSortModes: fieldType.supportedSortModes
      });
    });
  }
});
