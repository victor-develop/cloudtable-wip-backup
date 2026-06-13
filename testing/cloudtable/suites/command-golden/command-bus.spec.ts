import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { PermissionEngine } from "../../../../src/core/permissions/types";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import {
  createFixtureEventLedger,
  hydrateWorkflowAuthoringMetadata,
  toExpectedCommandResult
} from "../../harness/runners/command-fixture-executor";
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
    explainFieldAccess(field, surfaces = ["direct-record-read"]) {
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        surfaces: surfaces.map((surface) => ({
          allowed: true,
          message: "Allowed.",
          readState: "visible",
          reasonMessages: [],
          reasons: [],
          surface,
          writeAllowed: true
        }))
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
    const fixture = loadCommandFixture(scenarioId);

    it(`matches fixture ${scenarioId}`, async () => {
      const eventLedger = createFixtureEventLedger(fixture);
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
      expect(toCanonicalJson(actual)).toBe(
        toCanonicalJson(toExpectedCommandResult(fixture))
      );
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

  it("hydrates metadata-rich bindings for persistence-backed workflow fixtures", () => {
    expect(
      [
        {
          bindingName: "row.owner",
          scenarioId: "workflow-create-owner-binding-basic"
        },
        {
          bindingName: "row.assignee",
          scenarioId: "workflow-create-assignee-binding-basic"
        },
        {
          bindingName: "row.fields.status",
          scenarioId: "workflow-create-status-binding-mismatch"
        }
      ].map(({ bindingName, scenarioId }) => {
        const fixture = loadCommandFixture(scenarioId);
        const metadata = hydrateWorkflowAuthoringMetadata(fixture);
        const binding = metadata?.bindings[bindingName];

        return {
          bindingName,
          proposalHints: binding?.proposalHints.length ?? 0,
          scenarioId,
          supportedOperators: binding?.supportedOperators.length ?? 0
        };
      })
    ).toEqual([
      {
        bindingName: "row.owner",
        proposalHints: expect.any(Number),
        scenarioId: "workflow-create-owner-binding-basic",
        supportedOperators: expect.any(Number)
      },
      {
        bindingName: "row.assignee",
        proposalHints: expect.any(Number),
        scenarioId: "workflow-create-assignee-binding-basic",
        supportedOperators: expect.any(Number)
      },
      {
        bindingName: "row.fields.status",
        proposalHints: expect.any(Number),
        scenarioId: "workflow-create-status-binding-mismatch",
        supportedOperators: expect.any(Number)
      }
    ]);

    for (const [scenarioId, bindingName] of [
      ["workflow-create-owner-binding-basic", "row.owner"],
      ["workflow-create-assignee-binding-basic", "row.assignee"],
      ["workflow-create-status-binding-mismatch", "row.fields.status"]
    ] as const) {
      const fixture = loadCommandFixture(scenarioId);
      const binding = hydrateWorkflowAuthoringMetadata(fixture)?.bindings[bindingName];

      expect(binding, `${scenarioId}:${bindingName}`).toBeDefined();
      expect(binding?.supportedOperators.length, `${scenarioId}:${bindingName}:supportedOperators`).toBeGreaterThan(0);
      expect(binding?.proposalHints.length, `${scenarioId}:${bindingName}:proposalHints`).toBeGreaterThan(0);
    }
  });
});
