import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import type { IdempotencyReceipt } from "../../../../src/core/commands/types";
import type { PermissionEngine } from "../../../../src/core/permissions/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

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

  it("rejects unsupported command types explicitly", async () => {
    const eventLedger = new InMemoryEventLedger("2026-06-06T00:00:00.000Z");
    const commandBus = createCommandBus({
      eventLedger,
      fieldTypeRegistry,
      permissionEngine: createPermissionEngine({ allowed: true, reasons: [] }),
      workflowOperatorRegistry,
      idFactory(prefix) {
        return `${prefix}_0001`;
      },
      now() {
        return "2026-06-06T00:00:00.000Z";
      }
    });

    const actual = await commandBus.execute({
      actor: {
        mode: "user",
        principalId: "usr_alice"
      },
      commandId: "cmd_record_update_001",
      commandType: "records.upsert",
      idempotencyKey: "idem_record_update_001",
      payload: {
        patch: {}
      },
      scope: "table",
      tableId: "tbl_tasks",
      workspaceId: "ws_demo"
    });

    expect(actual).toMatchObject({
      accepted: false,
      diagnostics: ["unsupported_command_type:records.upsert"],
      events: [],
      replayProjection: {
        acceptedCommandIds: [],
        receiptCount: 0,
        receipts: []
      },
      sideEffects: [],
      status: "rejected"
    });
  });
});
