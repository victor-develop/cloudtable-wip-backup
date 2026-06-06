import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { IdempotencyReceipt } from "../../../../src/core/commands/types";
import type { FieldTypeRegistry } from "../../../../src/core/field-types/types";
import type { PermissionEngine } from "../../../../src/core/permissions/types";
import type { WorkflowOperatorRegistry } from "../../../../src/core/workflows/types";
import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const fieldTypeRegistry: FieldTypeRegistry = {
  get() {
    return undefined;
  },
  has() {
    return false;
  },
  list() {
    return [];
  },
  require(type) {
    throw new Error(`Unknown field type: ${type}`);
  }
};

const workflowOperatorRegistry: WorkflowOperatorRegistry = {
  get() {
    return undefined;
  },
  has() {
    return false;
  },
  list() {
    return [];
  },
  listByKind() {
    return [];
  },
  require(id) {
    throw new Error(`Unknown workflow operator: ${id}`);
  }
};

function createPermissionEngine(permission: {
  allowed: boolean;
  reasons: string[];
}): PermissionEngine {
  return {
    describeField() {
      return {
        readRedaction: "none",
        allowsMutation: true,
        allowsWorkflowTrigger: true,
        supportsValueVisibilityRules: false
      };
    },
    evaluateFieldAccess(field) {
      return {
        allowed: true,
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        readState: "visible",
        reasons: [],
        writeAllowed: true
      };
    },
    evaluateCommand() {
      return permission;
    },
    projectFields() {
      return {
        diagnostics: [],
        fields: {},
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: {}
      };
    },
    filterAgentTools(tools) {
      return tools.map((tool) => ({
        allowed: true,
        hiddenFieldIds: [],
        reason: null,
        toolId: tool.id,
        visibleFieldIds: []
      }));
    },
    resolveAgentToolFieldVisibility() {
      return {
        hiddenFieldIds: [],
        visibleFieldIds: [],
        writableFieldIds: []
      };
    },
    listSurfaces() {
      return [];
    }
  };
}

describe("cloudtable command bus", () => {
  for (const scenarioId of listCommandFixtureScenarioIds()) {
    it(`matches fixture ${scenarioId}`, async () => {
      const fixture = loadCommandFixture(scenarioId);
      const eventLedger = new InMemoryEventLedger(
        fixture.meta.logicalStartTime,
        (fixture.seedState.receipts ?? []) as unknown as IdempotencyReceipt[]
      );
      const commandBus = createCommandBus({
        eventLedger,
        fieldTypeRegistry,
        permissionEngine: createPermissionEngine(
          fixture.seedState.permission ?? { allowed: true, reasons: [] }
        ),
        workflowOperatorRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return fixture.meta.logicalStartTime;
        }
      });

      const actual = await commandBus.execute(fixture.command);
      expect(toCanonicalJson(actual)).toBe(toCanonicalJson(fixture.expected));
    });
  }
});
