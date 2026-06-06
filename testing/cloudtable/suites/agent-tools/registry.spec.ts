import { describe, expect, it } from "vitest";

import { createAgentToolRegistry } from "../../../../src/core/agent-tools/registry";
import type { CommandBus } from "../../../../src/core/commands/command-bus";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import { createPermissionEngine } from "../../../../src/core/permissions/engine";
import type { EffectivePermissionSnapshot } from "../../../../src/core/permissions/types";

const fieldTypeRegistry = createFieldTypeRegistry();

const snapshot: EffectivePermissionSnapshot = {
  snapshotId: "snap_001",
  workspaceId: "ws_demo",
  principalId: "usr_alice",
  policyRevision: 7,
  schemaEpoch: 3,
  scopeHash: "scope:view:view_tasks",
  fields: {
    title: {
      agent: true,
      fieldId: "title",
      fieldType: "text.single_line",
      read: "visible",
      workflow: true,
      write: true
    },
    customer_note: {
      agent: false,
      fieldId: "customer_note",
      fieldType: "text.long",
      read: "visible",
      workflow: true,
      write: true
    },
    health_score: {
      agent: true,
      fieldId: "health_score",
      fieldType: "computed.readonly",
      read: "visible",
      workflow: true,
      write: false
    }
  }
};

const fields = [
  {
    fieldId: "title",
    fieldType: "text.single_line"
  },
  {
    fieldId: "customer_note",
    fieldType: "text.long"
  },
  {
    fieldId: "health_score",
    fieldType: "computed.readonly"
  }
] as const;

function createRegistry() {
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot
  });
  const commandBus = {
    execute() {
      throw new Error("not used in agent tool registry tests");
    },
    normalizeFieldValue() {
      throw new Error("not used in agent tool registry tests");
    }
  } as CommandBus;

  return createAgentToolRegistry(permissionEngine, commandBus);
}

describe("cloudtable agent tool registry", () => {
  it("publishes the MVP tool contract with draft preview execute metadata", () => {
    const registry = createRegistry();

    expect(registry.list().map((tool) => tool.id)).toEqual([
      "schema.draft",
      "field.create.preview",
      "field.create.execute",
      "view.generate",
      "workflow.draft",
      "permission.explain",
      "bulk_update.preview",
      "bulk_update.execute"
    ]);

    expect(registry.require("field.create.preview")).toMatchObject({
      phase: "preview",
      requiresConfirmation: true,
      successorToolId: "field.create.execute"
    });
    expect(registry.require("bulk_update.execute")).toMatchObject({
      mutating: true,
      mutationTarget: "records",
      phase: "execute"
    });
  });

  it("keeps schema mutations accessible while denying record mutations without writable visible fields", () => {
    const registry = createRegistry();

    const accessible = registry.listAccessible(
      [
        {
          fieldId: "customer_note",
          fieldType: "text.long"
        },
        {
          fieldId: "health_score",
          fieldType: "computed.readonly"
        }
      ],
      snapshot
    );

    expect(accessible.find((tool) => tool.toolId === "field.create.execute")).toEqual({
      allowed: true,
      hiddenFieldIds: [],
      reason: null,
      toolId: "field.create.execute",
      visibleFieldIds: []
    });
    expect(accessible.find((tool) => tool.toolId === "bulk_update.execute")).toEqual({
      allowed: false,
      hiddenFieldIds: ["customer_note"],
      reason: "agent_mutation_denied",
      toolId: "bulk_update.execute",
      visibleFieldIds: ["health_score"]
    });
  });

  it("sanitizes hidden field references from tool inputs and outputs", () => {
    const registry = createRegistry();

    const sanitizedInput = registry.sanitizeInput(
      "bulk_update.preview",
      {
        fieldIds: ["title", "customer_note"],
        updates: [
          {
            fieldId: "customer_note",
            value: "hidden"
          },
          {
            fieldId: "title",
            value: "visible"
          }
        ]
      },
      fields,
      snapshot
    );
    const sanitizedOutput = registry.sanitizeOutput(
      "bulk_update.preview",
      {
        impactedFieldIds: ["title", "customer_note"],
        records: [
          {
            fields: {
              customer_note: "secret",
              title: "Q3 Renewal"
            },
            recordId: "rec_1"
          }
        ]
      },
      fields,
      snapshot
    );

    expect(sanitizedInput).toEqual({
      diagnostics: ["agent_hidden:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        fieldIds: ["title"],
        updates: [
          {
            fieldId: "title",
            value: "visible"
          }
        ]
      }
    });
    expect(sanitizedOutput).toEqual({
      diagnostics: ["agent_hidden:customer_note"],
      hiddenFieldIds: ["customer_note"],
      sanitized: {
        impactedFieldIds: ["title"],
        records: [
          {
            fields: {
              title: "Q3 Renewal"
            },
            recordId: "rec_1"
          }
        ]
      }
    });
  });
});
